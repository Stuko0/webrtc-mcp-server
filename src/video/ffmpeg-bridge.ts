import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { StreamInfo, StreamFrame, StreamSourceType, StreamStatus } from "./types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("ffmpeg-bridge");

const JPEG_SOI = Buffer.from([0xFF, 0xD8]);
const JPEG_EOI = Buffer.from([0xFF, 0xD9]);

export interface FfmpegBridgeEvents {
  frame: (frame: StreamFrame) => void;
  statusChange: (status: StreamStatus) => void;
  error: (error: string) => void;
}

export class FfmpegBridge extends EventEmitter {
  readonly streamId: string;
  readonly url: string;
  readonly sourceType: StreamSourceType;

  private proc: ChildProcess | null = null;
  private _status: StreamStatus = "disconnected";
  private buffer = Buffer.alloc(0);
  private frameSequence = 0;
  private _resolution: { width: number; height: number } | null = null;
  private _connectedAt = 0;
  private _framesCaptured = 0;
  private _lastFrameAt: number | null = null;
  private _error: string | null = null;
  private _reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private fps: number;
  private quality: number;
  private ffmpegPath: string;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;

  constructor(
    streamId: string,
    url: string,
    opts: {
      fps?: number;
      quality?: number;
      ffmpegPath?: string;
      maxReconnectAttempts?: number;
      reconnectDelayMs?: number;
    } = {},
  ) {
    super();
    this.streamId = streamId;
    this.url = url;
    this.sourceType = this._detectType(url);
    this.fps = opts.fps ?? 1;
    this.quality = opts.quality ?? 5;
    this.ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 3000;
  }

  get status(): string {
    return this._status;
  }

  get streamInfo(): StreamInfo {
    return {
      id: this.streamId,
      url: this.url,
      type: this.sourceType,
      status: this._status,
      resolution: this._resolution,
      fps: this.fps,
      connectedAt: this._connectedAt,
      framesCaptured: this._framesCaptured,
      lastFrameAt: this._lastFrameAt,
      error: this._error,
      reconnectAttempts: this._reconnectAttempts,
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /** Iniciar el stream. Dispara 'frame' por cada frame decodificado. */
  start(): void {
    this._spawnFfmpeg();
  }

  /** Detener el stream y matar FFmpeg. */
  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._kill();
    this._status = "disconnected";
    this.emit("statusChange", this._status);
  }

  /** Forzar reconexión. */
  reconnect(): void {
    this._reconnectAttempts++;
    logger.info("reconnecting", { streamId: this.streamId, attempt: this._reconnectAttempts });
    this._kill();
    this._status = "reconnecting";
    this.emit("statusChange", this._status);
    this._spawnFfmpeg();
  }

  // ─── Privado ────────────────────────────────────────────────

  private _detectType(url: string): StreamSourceType {
    if (url.startsWith("rtsp://") || url.startsWith("rtsps://")) return "rtsp";
    if (url.startsWith("rtmp://") || url.startsWith("rtmps://")) return "rtmp";
    if (url.includes(".m3u8")) return "hls";
    if (url.startsWith("file://") || url.startsWith("/")) return "file";
    return "unknown";
  }

  private _spawnFfmpeg(): void {
    // Build FFmpeg args according to source type
    const args: string[] = [];

    if (this.sourceType === "rtsp" || this.sourceType === "rtmp") {
      args.push("-rtsp_transport", "tcp");
    }

    // Handle lavfi test sources
    if (this.url.startsWith("testsrc") || this.url.startsWith("smptebars") || this.url.startsWith("color=")) {
      args.push("-f", "lavfi");
    }

    args.push("-i", this.url);
    args.push("-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", String(this.quality));
    args.push("-r", String(this.fps));
    args.push("pipe:1");

    logger.debug("spawning ffmpeg", { streamId: this.streamId, args: args.join(" ") });

    this.proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this._status = "connecting";
    this._connectedAt = Date.now();
    this.emit("statusChange", this._status);

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this._onData(chunk);
    });

    this.proc.stderr!.on("data", (data: Buffer) => {
      const text = data.toString();
      // Parsear resolución del log de FFmpeg
      const resMatch = text.match(/(\d+)x(\d+)(?:\s|,|$)/);
      if (resMatch && !this._resolution) {
        this._resolution = {
          width: parseInt(resMatch[1], 10),
          height: parseInt(resMatch[2], 10),
        };
        logger.debug("resolution detected", { streamId: this.streamId, res: this._resolution });
      }
    });

    this.proc.on("exit", (code, signal) => {
      logger.warn("ffmpeg exited", { streamId: this.streamId, code, signal });
      if (this._status !== "disconnected") {
        if (code === 0) {
          // Natural end of stream (e.g. test source with duration)
          this._status = "disconnected";
          this.emit("statusChange", this._status);
          return;
        }
        this._status = "error";
        this._error = `FFmpeg exited with code ${code ?? signal ?? "unknown"}`;
        this.emit("error", this._error);
        this.emit("statusChange", this._status);
        this._scheduleReconnect();
      }
    });

    this.proc.on("error", (err) => {
      logger.error("ffmpeg error", { streamId: this.streamId, error: err.message });
      this._error = err.message;
      this._status = "error";
      this.emit("error", err.message);
      this.emit("statusChange", this._status);
    });
  }

  /** Procesar datos del pipe de stdout: dividir por marcadores JPEG. */
  private _onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      // Buscar SOI (inicio de JPEG)
      const soiIdx = this.buffer.indexOf(JPEG_SOI);
      if (soiIdx === -1) {
        // Descartar basura antes del primer SOI
        this.buffer = Buffer.alloc(0);
        break;
      }

      // Buscar EOI después del SOI
      const eoiIdx = this.buffer.indexOf(JPEG_EOI, soiIdx + 2);
      if (eoiIdx === -1) break; // esperar más datos

      const frameData = this.buffer.subarray(soiIdx, eoiIdx + 2);
      this.buffer = this.buffer.subarray(eoiIdx + 2);

      this._framesCaptured++;
      this._lastFrameAt = Date.now();
      this.frameSequence++;

      if (this._status === "connecting") {
        this._status = "streaming";
        this.emit("statusChange", this._status);
      }

      const frame: StreamFrame = {
        streamId: this.streamId,
        data: frameData,
        timestamp: this._lastFrameAt,
        sequence: this.frameSequence,
        width: this._resolution?.width ?? 0,
        height: this._resolution?.height ?? 0,
        format: "jpeg",
      };

      this.emit("frame", frame);
    }
  }

  private _scheduleReconnect(): void {
    if (this._reconnectAttempts >= this.maxReconnectAttempts) {
      logger.warn("max reconnect attempts reached", {
        streamId: this.streamId,
        attempts: this._reconnectAttempts,
      });
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnect();
    }, this.reconnectDelayMs);
  }

  private _kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      // Forzar kill después de 3s si no termina
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
      }, 3000);
      this.proc = null;
    }
  }
}
