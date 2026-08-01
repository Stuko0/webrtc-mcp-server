import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "./types.js";

const DEFAULTS: ServerConfig = {
  maxWorkers: 8,
  connectionTimeoutMs: 30_000,
  iceRestartMaxRetries: 3,
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  dataChannel: { maxRetries: 5, retryBackoffMs: 1_000, maxMessageSize: 262_144 },
  signaling: { mode: "stdio", wsPort: 8765, wsHost: "127.0.0.1" },
  limits: { maxPeersPerWorker: 16, maxRooms: 100, maxPeersPerRoom: 32, maxMessageRate: 1000 },
  logging: { level: "info" },
};

function envInt(key: string, fb: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fb;
}

function envStr(key: string, fb: string): string {
  return process.env[key] ?? fb;
}

function loadJson(path: string): Partial<ServerConfig> | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<ServerConfig>;
  } catch {
    return null;
  }
}

export function loadConfig(): ServerConfig {
  const cfg = { ...DEFAULTS };

  // JSON config file
  const jsonPath = process.env.WEBRTC_CONFIG_PATH || join(process.cwd(), "config.json");
  if (existsSync(jsonPath)) {
    const overrides = loadJson(jsonPath);
    if (overrides) Object.assign(cfg, overrides);
  }

  // Env overrides
  cfg.maxWorkers = envInt("WEBRTC_MAX_WORKERS", cfg.maxWorkers);
  cfg.connectionTimeoutMs = envInt("WEBRTC_CONNECTION_TIMEOUT_MS", cfg.connectionTimeoutMs);
  cfg.dataChannel.maxMessageSize = envInt("WEBRTC_MAX_MESSAGE_SIZE", cfg.dataChannel.maxMessageSize);
  cfg.limits.maxPeersPerWorker = envInt("WEBRTC_MAX_PEERS_PER_WORKER", cfg.limits.maxPeersPerWorker);
  cfg.limits.maxRooms = envInt("WEBRTC_MAX_ROOMS", cfg.limits.maxRooms);
  cfg.signaling.mode = envStr("WEBRTC_SIGNALING_MODE", cfg.signaling.mode) as any;
  cfg.signaling.wsPort = envInt("WEBRTC_WS_PORT", cfg.signaling.wsPort);
  cfg.logging.level = envStr("WEBRTC_LOG_LEVEL", cfg.logging.level) as any;

  return cfg;
}
