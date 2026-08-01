/** Tipos para el subsistema de video (Fase 3). */

export type StreamSourceType = "rtsp" | "hls" | "rtmp" | "file" | "unknown";

export type StreamStatus = "connecting" | "streaming" | "error" | "disconnected" | "reconnecting";

export interface StreamInfo {
  id: string;
  url: string;
  type: StreamSourceType;
  status: StreamStatus;
  resolution: { width: number; height: number } | null;
  fps: number;
  connectedAt: number;
  framesCaptured: number;
  lastFrameAt: number | null;
  error: string | null;
  reconnectAttempts: number;
}

export interface StreamFrame {
  streamId: string;
  data: Buffer;
  timestamp: number;
  sequence: number;
  width: number;
  height: number;
  format: "jpeg";
}

export interface StreamConfig {
  reconnectMaxAttempts: number;
  reconnectDelayMs: number;
  frameCacheSize: number;
  ffmpegPath: string;
  defaultFps: number;
  defaultQuality: number;
}
