import { WebSocketServer, WebSocket } from "ws";
import type { SignalMessage, ServerConfig } from "../types.js";
import type { RoomManager } from "./room.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("ws-signaling");

interface WsPeer {
  ws: WebSocket;
  peerId: string;
  rooms: Set<string>;
  connectedAt: number;
}

export class WsSignalingServer {
  private wss: WebSocketServer | null = null;
  private peers = new Map<string, WsPeer>();
  private rooms: RoomManager;
  private config: ServerConfig;
  private onUndelivered: ((msg: any) => void) | null = null;

  constructor(rooms: RoomManager, config: ServerConfig) {
    this.rooms = rooms;
    this.config = config;
  }

  /** Hook para mensajes cuyo destino no es un peer WS (p.ej. el cliente MCP). */
  setUndeliveredHandler(fn: (msg: any) => void): void {
    this.onUndelivered = fn;
  }

  /** Iniciar el servidor WebSocket. */
  start(): void {
    const { wsPort, wsHost } = this.config.signaling;

    this.wss = new WebSocketServer({ host: wsHost, port: wsPort });

    this.wss.on("listening", () => {
      logger.info("ws signaling server started", { host: wsHost, port: wsPort });
    });

    this.wss.on("connection", (ws, req) => {
      const remoteAddr = req.socket.remoteAddress ?? "unknown";
      logger.debug("ws connection", { remoteAddr });

      // El peer aún no tiene ID — esperamos un join
      let peer: WsPeer | null = null;

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          switch (msg.type) {
            case "join":
              peer = this._handleJoin(ws, msg, remoteAddr);
              break;

            case "leave":
              if (peer) this._handleLeave(peer, msg);
              break;

            case "signal":
              if (peer) this._handleSignal(peer, msg);
              else this._sendError(ws, "Must join first");
              break;

            case "ping":
              this._send(ws, { type: "pong", timestamp: Date.now() });
              break;

            case "list_peers":
              this._send(ws, {
                type: "peers",
                peers: Array.from(this.peers.keys()),
                rooms: Array.from(this.rooms.list()).map((r) => ({
                  id: r.id,
                  peers: r.peers,
                  name: r.name,
                })),
              });
              break;

            case "command":
              if (peer) this._handleCommand(peer, msg);
              break;

            default:
              this._sendError(ws, `Unknown message type: ${msg.type}`);
          }
        } catch (err) {
          this._sendError(ws, `Parse error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      ws.on("close", () => {
        if (peer) this._handleDisconnect(peer);
      });

      ws.on("error", (err) => {
        logger.error("ws error", { remoteAddr, error: err.message });
      });

      // Timeout: si no hace join en 10s, cerramos
      const joinTimeout = setTimeout(() => {
        if (!peer) {
          logger.warn("ws join timeout", { remoteAddr });
          ws.close(4001, "Join timeout");
        }
      }, 10_000);

      ws.once("close", () => clearTimeout(joinTimeout));
    });

    this.wss.on("error", (err) => {
      logger.error("ws server error", { error: err.message });
    });
  }

  /** Detener el servidor. */
  stop(): void {
    for (const p of Array.from(this.peers.values())) {
      p.ws.close(1001, "Server shutting down");
    }
    this.peers.clear();
    this.wss?.close();
    logger.info("ws signaling server stopped");
  }

  /** Re-enviar una señal MCP interna a un peer WebSocket. */
  relayToPeer(peerId: string, signal: SignalMessage): boolean {
    const peer = this.peers.get(peerId);
    if (!peer || peer.ws.readyState !== WebSocket.OPEN) return false;
    this._send(peer.ws, { ...signal });
    return true;
  }

  /** Broadcast a todos los peers en un room. */
  broadcastToRoom(room: string, signal: SignalMessage, exclude?: string): number {
    let count = 0;
    const peers = this.rooms.getPeersInRoom(room, exclude);
    for (const peerId of peers) {
      if (this.relayToPeer(peerId, signal)) count++;
    }
    return count;
  }

  /** Obtener estadísticas. */
  getStats(): { connectedPeers: number; rooms: number } {
    return {
      connectedPeers: this.peers.size,
      rooms: this.rooms.list().length,
    };
  }

  // ─── Handlers internos ───────────────────────────────────

  private _handleJoin(ws: WebSocket, msg: any, remoteAddr: string): WsPeer | null {
    const peerId = msg.peerId ?? `ws-${remoteAddr}-${Date.now()}`;
    const room = msg.room ?? "default";

    if (this.peers.has(peerId)) {
      this._sendError(ws, `Peer ID already connected: ${peerId}`);
      return null;
    }

    const wp: WsPeer = { ws, peerId, rooms: new Set(), connectedAt: Date.now() };
    this.peers.set(peerId, wp);

    // Unir al room
    try {
      this.rooms.join(room, peerId, msg.label);
      wp.rooms.add(room);
    } catch (err) {
      this.peers.delete(peerId);
      this._sendError(ws, String(err));
      return null;
    }

    // Notificar a otros peers en el room
    this.broadcastToRoom(room, { type: "join", from: peerId, room }, peerId);

    // Enviar lista de peers existentes al que se une
    const existingPeers = this.rooms.getPeersInRoom(room, peerId);
    this._send(ws, {
      type: "room_peers",
      room,
      peers: existingPeers,
      yourId: peerId,
    });

    logger.info("ws peer joined", { peerId, room, remoteAddr });
    return wp;
  }

  private _handleLeave(peer: WsPeer, msg: any): void {
    const room = msg.room;
    if (!room) return;

    this.rooms.leave(room, peer.peerId);
    peer.rooms.delete(room);
    this.broadcastToRoom(room, { type: "leave", from: peer.peerId, room });
    logger.info("ws peer left", { peerId: peer.peerId, room });
  }

  private _handleSignal(peer: WsPeer, msg: any): void {
    const { to, sdp, candidate, type } = msg;
    if (!to) {
      this._sendError(peer.ws, "Signal requires 'to' field");
      return;
    }

    const signal: SignalMessage = {
      type: type ?? "signal",
      from: peer.peerId,
      to,
      sdp,
      candidate,
    };

    const delivered = this.relayToPeer(to, signal);
    if (!delivered) {
      logger.warn("ws signal target not found", { from: peer.peerId, to });
      this._sendError(peer.ws, `Peer not found: ${to}`);
    }
  }

  private _handleDisconnect(peer: WsPeer): void {
    for (const room of Array.from(peer.rooms)) {
      this.rooms.leave(room, peer.peerId);
      this.broadcastToRoom(room, { type: "leave", from: peer.peerId, room });
    }
    this.peers.delete(peer.peerId);
    logger.info("ws peer disconnected", { peerId: peer.peerId });
  }

  /** Re-enviar un comando/mensaje de un peer a otro (A → B). */
  private _handleCommand(peer: WsPeer, msg: any): void {
    const { to, room } = msg;

    // ── Control de permisos ─────────────────────────────────────
    // Asignar tareas (command "task") SOLO si el emisor es el principal del room.
    // Los workers secundarios pueden solicitar (status/status_result/task_result) pero no asignar.
    if (msg.command === "task" || msg.type === "task") {
      const roomId = room ?? Array.from(peer.rooms)[0] ?? "default";
      if (!this.rooms.isPrincipal(roomId, peer.peerId)) {
        const principal = this.rooms.getPrincipal(roomId);
        this._sendError(
          peer.ws,
          `Forbidden: solo el worker principal (${principal ?? "ninguno"}) puede asignar tareas. ` +
            `${peer.peerId} es worker secundario (solo puede solicitar).`
        );
        logger.warn("task assignment rejected (not principal)", { from: peer.peerId, room: roomId, principal });
        return;
      }
    }

    if (!to) {
      this._sendError(peer.ws, "Command requires 'to' field");
      return;
    }
    const relayed: SignalMessage = {
      type: "command",
      from: peer.peerId,
      to,
      data: msg.data ?? msg.command,
      room: msg.room,
      command: msg.command,
    };
    const delivered = this.relayToPeer(to, relayed);
    if (!delivered) {
      // El destino no es un peer WS → puede ser el cliente MCP (host) u otro peer
      if (this.onUndelivered) {
        this.onUndelivered(relayed);
      } else {
        logger.warn("ws command target not found", { from: peer.peerId, to });
        this._sendError(peer.ws, `Peer not found: ${to}`);
      }
    }
  }

  private _send(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private _sendError(ws: WebSocket, message: string): void {
    this._send(ws, { type: "error", message });
  }
}
