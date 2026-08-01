/**
 * Worker thread entry point.
 * Cada worker corre su propio event loop y maneja un subconjunto de peers.
 *
 * Protocolo de mensajes (JSON):
 *   { type: "connect", peerId, iceServers, dataChannels }
 *   { type: "disconnect", peerId }
 *   { type: "send", peerId, channel, msg }
 *   { type: "signal", peerId, sdp, candidate }
 *   { type: "ping" }
 *
 * Respuestas:
 *   { type: "connected", peerId, offer? }
 *   { type: "message", peerId, channel, data }
 *   { type: "state", peerId, state }
 *   { type: "error", peerId, error }
 *   { type: "pong" }
 */
import { parentPort } from "node:worker_threads";
import { loadWebRTC } from "../utils/webrtc.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("worker-instance");
const wrtc = loadWebRTC();

// peerId → { pc, channels }
const peers = new Map<string, { pc: any; channels: Map<string, any> }>();

if (!parentPort) {
  process.exit(1);
}

// Notificar que el worker está listo
parentPort.postMessage({ type: "ready", workerId: process.env.WORKER_ID ?? "unknown" });

parentPort.on("message", async (msg: any) => {
  try {
    switch (msg.type) {
      case "connect":
        await handleConnect(msg);
        break;
      case "disconnect":
        handleDisconnect(msg);
        break;
      case "send":
        handleSend(msg);
        break;
      case "signal":
        await handleSignal(msg);
        break;
      case "ping":
        parentPort!.postMessage({ type: "pong", ts: Date.now() });
        break;
    }
  } catch (err) {
    parentPort!.postMessage({ type: "error", peerId: msg.peerId, error: String(err) });
  }
});

async function handleConnect(msg: any): Promise<void> {
  const { peerId, iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }], dataChannels = ["default"] } = msg;
  if (peers.has(peerId)) throw new Error(`Peer ${peerId} already exists`);

  const pc = new wrtc.RTCPeerConnection({ iceServers });
  const channels = new Map<string, any>();

  pc.onicecandidate = (event: any) => {
    if (event.candidate) {
      parentPort!.postMessage({ type: "ice", peerId, candidate: event.candidate.toJSON() });
    }
  };
  pc.onconnectionstatechange = () => {
    parentPort!.postMessage({ type: "state", peerId, state: pc.connectionState });
  };

  // Crear DataChannels
  for (const label of dataChannels) {
    const dc = pc.createDataChannel(label, { ordered: true, maxRetransmits: 3 });
    setupDataChannel(peerId, label, dc, channels);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  peers.set(peerId, { pc, channels });
  parentPort!.postMessage({ type: "connected", peerId, offer });
}

function handleDisconnect(msg: any): void {
  const peer = peers.get(msg.peerId);
  if (!peer) return;
  for (const dc of Array.from(peer.channels.values())) dc.close();
  peer.channels.clear();
  peer.pc.close();
  peers.delete(msg.peerId);
  parentPort!.postMessage({ type: "state", peerId: msg.peerId, state: "closed" });
}

function handleSend(msg: any): void {
  const peer = peers.get(msg.peerId);
  if (!peer) {
    parentPort!.postMessage({ type: "error", peerId: msg.peerId, error: "peer not found" });
    return;
  }
  const dc = peer.channels.get(msg.channel ?? "default");
  if (!dc || dc.readyState !== "open") {
    parentPort!.postMessage({ type: "error", peerId: msg.peerId, error: "channel not open" });
    return;
  }
  dc.send(JSON.stringify(msg.msg));
}

async function handleSignal(msg: any): Promise<void> {
  const peer = peers.get(msg.peerId);
  if (!peer) {
    parentPort!.postMessage({ type: "error", peerId: msg.peerId, error: "peer not found" });
    return;
  }
  if (msg.sdp) {
    await peer.pc.setRemoteDescription(new wrtc.RTCSessionDescription(msg.sdp));
    if (msg.sdp.type === "offer") {
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      parentPort!.postMessage({ type: "answer", peerId: msg.peerId, sdp: answer });
    }
  }
  if (msg.candidate) {
    await peer.pc.addIceCandidate(new wrtc.RTCIceCandidate(msg.candidate));
  }
}

function setupDataChannel(peerId: string, label: string, dc: any, channels: Map<string, any>): void {
  channels.set(label, dc);
  dc.onopen = () => parentPort!.postMessage({ type: "dc_state", peerId, label, state: "open" });
  dc.onclose = () => { channels.delete(label); };
  dc.onmessage = (event: any) => {
    try {
      const data = JSON.parse(event.data);
      parentPort!.postMessage({ type: "message", peerId, channel: label, data });
    } catch { /* ignore parse errors in worker */ }
  };
}
