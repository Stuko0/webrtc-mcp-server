import { WebRTCTransport } from "../transports/webrtc.js";
import type {
  RTCIceServer,
  RTCSessionDescriptionInit,
  RTCIceCandidateInit,
} from "../utils/webrtc.js";
import type { DataChannelMessage } from "../types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("webrtc-mgr");

export interface WebRTCManagerCallbacks {
  onMessage: (peerId: string, msg: DataChannelMessage) => void;
  onIceCandidate: (peerId: string, candidate: RTCIceCandidateInit) => void;
  onStateChange: (peerId: string, state: string) => void;
}

/**
 * Gestor de conexiones WebRTC reales (hilo principal).
 *
 * IMPORTANTE: @roamhq/wrtc (libwebrtc nativo) NO es seguro en worker_threads —
 * crear un RTCPeerConnection dentro de un Worker crashea V8 con
 * "HandleScope Entering the V8 API without proper locking" (fatal, mata el
 * proceso). Por eso todas las PeerConnections viven aquí, en el hilo principal.
 */
export class WebRTCConnectionManager {
  private connections = new Map<string, WebRTCTransport>();
  private iceServers: RTCIceServer[];
  private callbacks: WebRTCManagerCallbacks;

  constructor(iceServers: RTCIceServer[], callbacks: WebRTCManagerCallbacks) {
    this.iceServers = iceServers;
    this.callbacks = callbacks;
  }

  /** Crear conexión como caller → offer SDP real + DataChannel(s). */
  async connect(
    peerId: string,
    opts: { iceServers?: RTCIceServer[]; dataChannels?: string[] } = {},
  ): Promise<RTCSessionDescriptionInit> {
    if (this.connections.has(peerId)) {
      throw new Error(`Peer ${peerId} ya tiene una conexión WebRTC activa`);
    }
    const transport = new WebRTCTransport(peerId, opts.iceServers ?? this.iceServers, {
      onMessage: (p, m) => this.callbacks.onMessage(p, m),
      onStateChange: (p, s) => this.callbacks.onStateChange(p, s),
      onIceCandidate: (p, c) => this.callbacks.onIceCandidate(p, c),
    });
    this.connections.set(peerId, transport);
    try {
      return await transport.connect(opts.dataChannels ?? ["default"]);
    } catch (err) {
      this.connections.delete(peerId);
      throw err;
    }
  }

  /**
   * Procesar una señal remota del peer (answer SDP o ICE candidate).
   * El host siempre actúa como caller (acceptAnswer) en este flujo.
   */
  async signal(
    peerId: string,
    sig: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit },
  ): Promise<boolean> {
    const t = this.connections.get(peerId);
    if (!t) return false;
    try {
      if (sig.sdp) {
        logger.debug("signal sdp", { peerId, type: sig.sdp.type });
        await t.acceptAnswer(sig.sdp);
      }
      if (sig.candidate) {
        logger.debug("signal candidate", { peerId, cand: String(sig.candidate.candidate).slice(0, 60) });
        await t.addIceCandidate(sig.candidate);
      }
      return true;
    } catch (err) {
      logger.warn("signal failed", { peerId, error: String(err) });
      return false;
    }
  }

  /** Enviar mensaje por DataChannel "default". */
  send(peerId: string, msg: DataChannelMessage): boolean {
    const t = this.connections.get(peerId);
    if (!t) return false;
    return t.send("default", msg);
  }

  /** Estado de la conexión de un peer (null si no existe). */
  state(peerId: string): string | null {
    return this.connections.get(peerId)?.state ?? null;
  }

  /** PeerIds con conexión activa. */
  list(): string[] {
    return Array.from(this.connections.keys());
  }

  /** Cerrar la conexión de un peer. */
  disconnect(peerId: string): boolean {
    const t = this.connections.get(peerId);
    if (!t) return false;
    t.close();
    this.connections.delete(peerId);
    logger.info("webrtc connection closed", { peerId });
    return true;
  }

  /** Cerrar todas las conexiones (cleanup). */
  closeAll(): void {
    for (const id of Array.from(this.connections.keys())) this.disconnect(id);
  }
}
