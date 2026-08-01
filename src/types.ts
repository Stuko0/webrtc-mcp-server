import type { RTCIceCandidateInit, RTCIceServer } from "./utils/webrtc.js";

// ─── Peer / Connection ────────────────────────────────────────

export type ConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export interface PeerInfo {
  id: string;
  label: string;
  state: ConnectionState;
  remoteAddress?: string;
  dataChannels: string[];
  connectedAt: number;
  bytesSent: number;
  bytesReceived: number;
  roundTripTimeMs?: number;
}

// ─── Room (grupo de peers para multi-agente) ──────────────────

export interface RoomInfo {
  id: string;
  name: string;
  peers: string[];
  createdAt: number;
  /** Peer principal (jefe): el primer worker que se unió. Solo él puede asignar tareas. */
  principal?: string;
}

// ─── Signal (intercambio SDP / ICE) ───────────────────────────

export type SignalType =
  | "offer"
  | "answer"
  | "ice_candidate"
  | "ice_restart"
  | "join"
  | "leave"
  | "command"
  | "task";

export interface SignalMessage {
  type: SignalType;
  from: string;
  to?: string;
  room?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  label?: string;
  data?: unknown;
  command?: string;
}

// ─── DataChannel message ──────────────────────────────────────

export interface DataChannelMessage {
  from: string;
  to?: string;          // omit => broadcast
  room?: string;
  kind: "data" | "command" | "offer" | "answer" | "ice";
  payload: unknown;
  timestamp: number;
  id: string;
}

// ─── MCP tool schemas (para el handler) ───────────────────────

export interface ConnectParams {
  peerId: string;
  label?: string;
  iceServers?: RTCIceServer[];
  dataChannels?: string[];
  mode?: "mesh" | "direct";
}

export interface SendParams {
  peerId: string;
  data: unknown;
  channel?: string;
  kind?: "data" | "command";
}

export interface BroadcastParams {
  data: unknown;
  channel?: string;
  kind?: "data" | "command";
  exclude?: string[];
}

export interface RoomParams {
  room: string;
  peerId?: string;
  name?: string;
}

// ─── Config ───────────────────────────────────────────────────

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface ServerConfig {
  maxWorkers: number;
  connectionTimeoutMs: number;
  iceRestartMaxRetries: number;
  iceServers: IceServerConfig[];
  dataChannel: {
    maxRetries: number;
    retryBackoffMs: number;
    maxMessageSize: number;
  };
  signaling: {
    mode: "stdio" | "ws" | "both";
    wsPort: number;
    wsHost: string;
  };
  limits: {
    maxPeersPerWorker: number;
    maxRooms: number;
    maxPeersPerRoom: number;
    maxMessageRate: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
}
