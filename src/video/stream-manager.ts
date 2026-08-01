/**
 * Stream Manager — coordina múltiples FfmpegBridge instances.
 *
 * Es el punto de entrada para el MCP handler. Cada stream
 * tiene un ID único (nanoid) y su propio bridge + cache.
 */
import { nanoid } from "nanoid";
import { FfmpegBridge } from "./ffmpeg-bridge.js";
import { FrameCache } from "./frame-cache.js";
import type { StreamInfo, StreamFrame } from "./types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("stream-mgr");

export interface StreamBridgeOptions {
  fps?: number;
  quality?: number;
  ffmpegPath?: string;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
}

export class StreamManager {
  private bridges = new Map<string, FfmpegBridge>();
  private cache = new FrameCache(5);
  private options: Required<StreamBridgeOptions>;

  constructor(opts: StreamBridgeOptions = {}) {
    this.options = {
      fps: opts.fps ?? 1,
      quality: opts.quality ?? 5,
      ffmpegPath: opts.ffmpegPath ?? "ffmpeg",
      maxReconnectAttempts: opts.maxReconnectAttempts ?? 5,
      reconnectDelayMs: opts.reconnectDelayMs ?? 3000,
    };
  }

  /**
   * Conectar a un stream RTSP/HLS.
   * @returns streamId
   */
  connect(url: string, opts?: StreamBridgeOptions): string {
    const id = nanoid(12);
    const merged = { ...this.options, ...opts };

    const bridge = new FfmpegBridge(id, url, merged);

    // Puente: frame event → cache
    bridge.on("frame", (frame: StreamFrame) => {
      this.cache.push(frame);
    });

    bridge.on("error", (err: string) => {
      logger.error("stream error", { streamId: id, error: err });
    });

    bridge.start();
    this.bridges.set(id, bridge);

    logger.info("stream connected", { id, url: url.slice(0, 60) });
    return id;
  }

  /** Desconectar y liberar un stream. */
  disconnect(streamId: string): boolean {
    const bridge = this.bridges.get(streamId);
    if (!bridge) return false;
    bridge.stop();
    this.bridges.delete(streamId);
    this.cache.clear(streamId);
    logger.info("stream disconnected", { streamId });
    return true;
  }

  /** Forzar reconexión de un stream. */
  reconnect(streamId: string): boolean {
    const bridge = this.bridges.get(streamId);
    if (!bridge) return false;
    bridge.reconnect();
    return true;
  }

  /** Obtener el último frame de un stream. */
  getFrame(streamId: string): StreamFrame | null {
    return this.cache.getLatest(streamId);
  }

  /** Obtener info de todos los streams. */
  listStreams(): StreamInfo[] {
    return Array.from(this.bridges.values()).map((b) => b.streamInfo);
  }

  /** Obtener info de un stream específico. */
  getStreamInfo(streamId: string): StreamInfo | null {
    return this.bridges.get(streamId)?.streamInfo ?? null;
  }

  /** Cantidad de streams activos. */
  get activeCount(): number {
    return this.bridges.size;
  }

  /** Detener todos los streams (cleanup). */
  stopAll(): void {
    for (const [id, bridge] of Array.from(this.bridges)) {
      bridge.stop();
      this.cache.clear(id);
    }
    this.bridges.clear();
    logger.info("all streams stopped");
  }
}
