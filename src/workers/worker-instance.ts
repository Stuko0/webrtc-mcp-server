import { parentPort } from "node:worker_threads";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("worker-instance");

if (!parentPort) {
  process.exit(1);
}

// Notificar que el worker está listo
parentPort.postMessage({ type: "ready", workerId: process.env.WORKER_ID ?? "unknown" });

/**
 * Worker genérico del pool.
 *
 * NOTA: @roamhq/wrtc (libwebrtc) NO es seguro en worker_threads — crear un
 * RTCPeerConnection aquí crashea V8 ("HandleScope Entering the V8 API without
 * proper locking"). Toda la lógica WebRTC real vive en el hilo principal
 * (WebRTCConnectionManager). Este worker solo maneja tareas CPU-bound
 * genéricas (ping/echo) y responde errores claros si recibe comandos WebRTC.
 */
parentPort.on("message", (msg: any) => {
  try {
    switch (msg.type) {
      case "connect":
      case "disconnect":
      case "send":
      case "signal":
        parentPort!.postMessage({
          type: "error",
          peerId: msg.peerId,
          error: "WebRTC no se ejecuta en worker_threads (@roamhq/wrtc no es thread-safe); usa el transporte del hilo principal (WebRTCConnectionManager)",
        });
        break;
      case "ping":
        parentPort!.postMessage({ type: "pong", ts: Date.now() });
        break;
      case "shutdown":
        parentPort!.close();
        break;
      default:
        parentPort!.postMessage({ type: "error", error: `Unknown message type: ${msg.type}` });
    }
  } catch (err) {
    parentPort!.postMessage({ type: "error", peerId: msg.peerId, error: String(err) });
  }
});
