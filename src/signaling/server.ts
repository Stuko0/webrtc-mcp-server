/**
 * Signaling Server — intercambio SDP/ICE entre peers.
 *
 * Usa MCP JSON-RPC como canal de señalización (modo stdio)
 * y opcionalmente WebSocket (modo ws/both) para peers externos.
 */
import { EventEmitter } from "node:events";
import type { SignalMessage, ServerConfig } from "../types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("signaling");

type SignalHandler = (msg: SignalMessage) => void;

export class SignalingServer {
  private pendingSignals = new Map<string, SignalMessage[]>();
  private listeners = new Map<string, Set<SignalHandler>>();
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /** Escuchar señales de un tipo específico. */
  on(event: string, handler: SignalHandler): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
  }

  /** Emitir señal. */
  private emit(event: string, msg: SignalMessage): void {
    this.listeners.get(event)?.forEach((h) => h(msg));
  }

  /** Crear offer para un peer. */
  createOffer(peerId: string, label?: string): SignalMessage {
    const msg: SignalMessage = { type: "offer", from: "server", to: peerId, label };
    this._enqueue(peerId, msg);
    return msg;
  }

  /** Procesar answer. */
  processAnswer(from: string, sdp: string): SignalMessage {
    return { type: "answer", from, sdp };
  }

  /** Routear ICE candidate a un peer o broadcast. */
  routeIceCandidate(from: string, candidate: any, to?: string): void {
    const msg: SignalMessage = { type: "ice_candidate", from, candidate };
    if (to) this.emit("signal", { ...msg, to });
    else this.emit("signal", msg);
  }

  /** Unir peer a room. */
  joinRoom(peerId: string, room: string): SignalMessage {
    const msg: SignalMessage = { type: "join", from: peerId, room };
    this.emit("signal", msg);
    return msg;
  }

  /** Salir de room. */
  leaveRoom(peerId: string, room: string): SignalMessage {
    const msg: SignalMessage = { type: "leave", from: peerId, room };
    this.emit("signal", msg);
    return msg;
  }

  /** Desencolar señales pendientes de un peer. */
  dequeueSignals(peerId: string): SignalMessage[] {
    const sigs = this.pendingSignals.get(peerId) ?? [];
    this.pendingSignals.delete(peerId);
    return sigs;
  }

  /** ICE restart. */
  iceRestart(peerId: string): SignalMessage {
    const msg: SignalMessage = { type: "ice_restart", from: "server", to: peerId };
    this._enqueue(peerId, msg);
    return msg;
  }

  private _enqueue(peerId: string, msg: SignalMessage): void {
    const q = this.pendingSignals.get(peerId) ?? [];
    q.push(msg);
    this.pendingSignals.set(peerId, q);
    this.emit("signal", msg);
  }
}
