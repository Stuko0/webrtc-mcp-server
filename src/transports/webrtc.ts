/**
 * WebRTC Transport — PeerConnection + DataChannel management.
 * Cada instancia maneja UNA conexión RTCPeerConnection.
 * Corre en un Worker Thread.
 */
import { createLogger } from "../utils/logger.js";
import { loadWebRTC } from "../utils/webrtc.js";
import type * as wrtc from "../utils/webrtc.js";
import type { DataChannelMessage } from "../types.js";

const logger = createLogger("webrtc-transport");

export interface TransportCallbacks {
  onMessage: (peerId: string, msg: DataChannelMessage) => void;
  onStateChange: (peerId: string, state: wrtc.PeerConnectionState) => void;
  onIceCandidate: (peerId: string, candidate: wrtc.RTCIceCandidateInit) => void;
}

export class WebRTCTransport {
  readonly peerId: string;
  private pc: any = null;
  private dataChannels = new Map<string, wrtc.RTCDataChannel>();
  private callbacks: TransportCallbacks;
  private _state: wrtc.PeerConnectionState = "new";
  private _bytesSent = 0;
  private _bytesReceived = 0;
  private _connectedAt = 0;
  private wrtc: ReturnType<typeof loadWebRTC>;
  private iceServers: wrtc.RTCIceServer[];

  constructor(peerId: string, iceServers: wrtc.RTCIceServer[], callbacks: TransportCallbacks) {
    this.peerId = peerId;
    this.callbacks = callbacks;
    this.iceServers = iceServers;
    this.wrtc = loadWebRTC();
  }

  get state(): wrtc.PeerConnectionState { return this._state; }

  // ─── Lifecycle ──────────────────────────────────────────────

  /** Iniciar como caller → crea offer + DataChannels. */
  async connect(dataChannelLabels: string[] = ["default"]): Promise<wrtc.RTCSessionDescriptionInit> {
    this.pc = this._createPC();
    for (const label of dataChannelLabels) this._createDC(label);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /** Responder a un offer como callee. */
  async acceptOffer(offer: wrtc.RTCSessionDescriptionInit): Promise<wrtc.RTCSessionDescriptionInit> {
    this.pc = this._createPC();
    this.pc.ondatachannel = (event: any) => this._registerDC(event.channel);
    await this.pc.setRemoteDescription(new this.wrtc.RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /** Caller acepta answer. */
  async acceptAnswer(answer: wrtc.RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) throw new Error("No PC");
    await this.pc.setRemoteDescription(new this.wrtc.RTCSessionDescription(answer));
  }

  /** Agregar ICE candidate remoto. */
  async addIceCandidate(candidate: wrtc.RTCIceCandidateInit): Promise<void> {
    if (!this.pc) throw new Error("No PC");
    await this.pc.addIceCandidate(new this.wrtc.RTCIceCandidate(candidate));
  }

  /** Enviar mensaje por DataChannel. */
  send(channelLabel: string, msg: DataChannelMessage): boolean {
    const dc = this.dataChannels.get(channelLabel);
    if (!dc || dc.readyState !== "open") { logger.warn("dc not open", { peer: this.peerId, channelLabel, state: dc?.readyState }); return false; }
    const payload = JSON.stringify(msg);
    dc.send(payload);
    this._bytesSent += Buffer.byteLength(payload, "utf-8");
    return true;
  }

  /** ICE restart. */
  async iceRestart(): Promise<wrtc.RTCSessionDescriptionInit> {
    if (!this.pc) throw new Error("No PC");
    this.pc.restartIce();
    const offer = await this.pc.createOffer({ iceRestart: true });
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /** Cerrar. */
  close(): void {
    for (const dc of this.dataChannels.values()) dc.close();
    this.dataChannels.clear();
    if (this.pc) { this.pc.close(); this.pc = null; }
    this._state = "closed";
    this.callbacks.onStateChange(this.peerId, "closed");
  }

  // ─── Privado ────────────────────────────────────────────────

  private _createPC(): any {
    const pc = new this.wrtc.RTCPeerConnection({ iceServers: this.iceServers });

    pc.onicecandidate = (event: any) => {
      if (event.candidate) this.callbacks.onIceCandidate(this.peerId, event.candidate.toJSON());
    };

    pc.onconnectionstatechange = () => {
      this._state = pc.connectionState;
      if (pc.connectionState === "connected") this._connectedAt = Date.now();
      this.callbacks.onStateChange(this.peerId, this._state);
    };

    pc.oniceconnectionstatechange = () => {
      logger.debug("ice state", { peer: this.peerId, iceState: pc.iceConnectionState });
    };

    return pc;
  }

  private _createDC(label: string): wrtc.RTCDataChannel {
    const dc = this.pc.createDataChannel(label, { ordered: true, maxRetransmits: 3 });
    this._registerDC(dc);
    return dc;
  }

  private _registerDC(dc: wrtc.RTCDataChannel): void {
    this.dataChannels.set(dc.label, dc);
    dc.onopen = () => logger.debug("dc open", { peer: this.peerId, label: dc.label });
    dc.onclose = () => { this.dataChannels.delete(dc.label); };
    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as DataChannelMessage;
        this._bytesReceived += Buffer.byteLength(event.data, "utf-8");
        this.callbacks.onMessage(this.peerId, msg);
      } catch (err) {
        logger.warn("dc parse fail", { peer: this.peerId, error: String(err) });
      }
    };
  }
}
