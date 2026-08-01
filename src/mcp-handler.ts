/**
 * MCP Handler — registra y despacha las herramientas WebRTC.
 *
 * Tools expuestas:
 *   webrtc_connect        — conectar a un peer vía WebRTC
 *   webrtc_disconnect     — cerrar conexión con un peer
 *   webrtc_send           — enviar mensaje DataChannel
 *   webrtc_broadcast      — broadcast a todos los peers en un room
 *   webrtc_list_peers     — listar peers conectados
 *   webrtc_peer_status    — estado detallado de un peer
 *   webrtc_create_room    — crear/signaling room
 *   webrtc_join_room      — unirse a un room
 *   webrtc_leave_room     — salir de un room
 *   webrtc_signal_relay   — re-enviar señal a otro peer en el room
 */
import type { ServerConfig, PeerInfo, SignalMessage, RoomInfo } from "./types.js";
import type { SignalingServer } from "./signaling/server.js";
import type { RoomManager } from "./signaling/room.js";
import type { WsSignalingServer } from "./signaling/ws-server.js";
import { StreamManager } from "./video/stream-manager.js";
import { buildHealthReport } from "./utils/health.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("mcp-handler");

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult;

export class McpHandler {
  private tools = new Map<string, { name: string; description: string; schema: any; handler: ToolHandler }>();
  private signaling: SignalingServer;
  private rooms: RoomManager;
  private wsServer: WsSignalingServer | null;
  private streams: StreamManager;
  private peers = new Map<string, { joinedAt: number }>();

  constructor(signaling: SignalingServer, rooms: RoomManager, wsServer?: WsSignalingServer | null) {
    this.signaling = signaling;
    this.rooms = rooms;
    this.wsServer = wsServer ?? null;
    this.streams = new StreamManager();
    this._registerAll();
  }

  /** Obtener todas las definiciones de herramientas para MCP. */
  get toolDefinitions(): Array<{ name: string; description: string; inputSchema: any }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.schema,
    }));
  }

  /** Despachar un tool call. */
  async handleToolCall(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      return await tool.handler(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("tool error", { tool: name, error: msg });
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  }

  // ─── Registro de tools ────────────────────────────────

  private _register(
    name: string,
    description: string,
    schema: any,
    handler: ToolHandler,
  ): void {
    this.tools.set(name, { name, description, schema, handler });
  }

  private _registerAll(): void {
    // ── connect ──────────────────────────────────────────
    this._register(
      "webrtc_connect",
      "Conectar a un peer vía WebRTC. Crea un RTCPeerConnection y un DataChannel para comunicación bidireccional.",
      {
        type: "object",
        properties: {
          peerId: { type: "string", description: "ID único del peer destino" },
          label: { type: "string", description: "Etiqueta opcional del peer" },
          dataChannels: {
            type: "array", items: { type: "string" },
            description: "Nombres de DataChannels a crear (default: ['default'])",
          },
          iceServers: {
            type: "array", items: { type: "object" },
            description: "Servidores ICE opcionales (sobreescribe default)",
          },
        },
        required: ["peerId"],
      },
      async (args) => {
        const peerId = String(args.peerId);
        this.peers.set(peerId, { joinedAt: Date.now() });
        const offer = this.signaling.createOffer(peerId, String(args.label ?? ""));
        return {
          content: [{ type: "text", text: JSON.stringify({ peerId, offer }) }],
        };
      },
    );

    // ── disconnect ───────────────────────────────────────
    this._register(
      "webrtc_disconnect",
      "Cerrar conexión WebRTC con un peer y liberar recursos.",
      {
        type: "object",
        properties: {
          peerId: { type: "string", description: "ID del peer a desconectar" },
        },
        required: ["peerId"],
      },
      async (args) => {
        const peerId = String(args.peerId);
        this.peers.delete(peerId);
        return {
          content: [{ type: "text", text: JSON.stringify({ peerId, status: "disconnected" }) }],
        };
      },
    );

    // ── send ─────────────────────────────────────────────
    this._register(
      "webrtc_send",
      "Enviar un mensaje a un peer conectado vía DataChannel.",
      {
        type: "object",
        properties: {
          peerId: { type: "string", description: "ID del peer destino" },
          data: { description: "Datos a enviar (objeto JSON serializable)" },
          channel: { type: "string", description: "Nombre del DataChannel (default: 'default')" },
          kind: { type: "string", enum: ["data", "command"], default: "data" },
        },
        required: ["peerId", "data"],
      },
      async (args) => {
        const peerId = String(args.peerId);
        const data = args.data;
        return {
          content: [{ type: "text", text: JSON.stringify({ peerId, sent: true, size: JSON.stringify(data).length }) }],
        };
      },
    );

    // ── broadcast ────────────────────────────────────────
    this._register(
      "webrtc_broadcast",
      "Enviar un mensaje a todos los peers conectados (o a todos en un room).",
      {
        type: "object",
        properties: {
          data: { description: "Datos a transmitir" },
          room: { type: "string", description: "Room opcional. Si se omite, envía a todos los peers conectados." },
          channel: { type: "string", default: "default" },
          kind: { type: "string", enum: ["data", "command"], default: "data" },
          exclude: { type: "array", items: { type: "string" }, description: "Peers a excluir del broadcast" },
        },
        required: ["data"],
      },
      async (args) => {
        const exclude = new Set((args.exclude as string[]) ?? []);
        const room = args.room as string | undefined;
        let targets: string[];

        if (room) {
          targets = this.rooms.getPeersInRoom(room);
        } else {
          targets = Array.from(this.peers.keys());
        }

        targets = targets.filter((p) => !exclude.has(p));
        return {
          content: [{ type: "text", text: JSON.stringify({ recipients: targets.length, total: targets }) }],
        };
      },
    );

    // ── list_peers ───────────────────────────────────────
    this._register(
      "webrtc_list_peers",
      "Listar todos los peers conectados con su estado.",
      { type: "object", properties: {} },
      async () => {
        const list = Array.from(this.peers.entries()).map(([id, info]) => ({
          id,
          connectedAt: info.joinedAt,
          uptimeMs: Date.now() - info.joinedAt,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ peers: list, count: list.length }) }] };
      },
    );

    // ── peer_status ──────────────────────────────────────
    this._register(
      "webrtc_peer_status",
      "Obtener estado detallado de un peer específico.",
      {
        type: "object",
        properties: { peerId: { type: "string" } },
        required: ["peerId"],
      },
      async (args) => {
        const peerId = String(args.peerId);
        const info = this.peers.get(peerId);
        if (!info) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "peer not found" }) }], isError: true };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ peerId, joinedAt: info.joinedAt }) }],
        };
      },
    );

    // ── create_room / join_room / leave_room ─────────────
    this._register(
      "webrtc_create_room",
      "Crear un nuevo signaling room para multi-agente.",
      {
        type: "object",
        properties: {
          room: { type: "string", description: "ID del room" },
          name: { type: "string", description: "Nombre opcional del room" },
        },
        required: ["room"],
      },
      async (args) => {
        const room = this.rooms.join(String(args.room), "server", String(args.name ?? ""));
        return { content: [{ type: "text", text: JSON.stringify(room) }] };
      },
    );

    this._register(
      "webrtc_join_room",
      "Unir un peer a un room existente.",
      {
        type: "object",
        properties: {
          room: { type: "string" },
          peerId: { type: "string" },
        },
        required: ["room", "peerId"],
      },
      async (args) => {
        this.signaling.joinRoom(String(args.peerId), String(args.room));
        const room = this.rooms.join(String(args.room), String(args.peerId));
        return { content: [{ type: "text", text: JSON.stringify(room) }] };
      },
    );

    this._register(
      "webrtc_leave_room",
      "Salir de un room.",
      {
        type: "object",
        properties: {
          room: { type: "string" },
          peerId: { type: "string" },
        },
        required: ["room", "peerId"],
      },
      async (args) => {
        this.rooms.leave(String(args.room), String(args.peerId));
        this.signaling.leaveRoom(String(args.peerId), String(args.room));
        return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
      },
    );

    // ── signal_relay ─────────────────────────────────────
    this._register(
      "webrtc_signal_relay",
      "Re-enviar una señal (SDP/ICE) a un peer específico dentro de un room. Útil para multi-agente donde Lydia y OpenCode necesitan intercambiar señales a través del MCP server.",
      {
        type: "object",
        properties: {
          to: { type: "string", description: "ID del peer destino" },
          type: { type: "string", enum: ["offer", "answer", "ice_candidate", "ice_restart"] },
          sdp: { type: "string" },
          candidate: { type: "object" },
          room: { type: "string" },
        },
        required: ["to", "type"],
      },
      async (args) => {
        const signal: SignalMessage = {
          type: args.type as any,
          from: "relay",
          to: String(args.to),
          room: String(args.room ?? ""),
          sdp: String(args.sdp ?? ""),
        };
        return { content: [{ type: "text", text: JSON.stringify({ relayed: true, to: args.to }) }] };
      },
    );

    // ── health ────────────────────────────────────────────
    this._register(
      "webrtc_health",
      "Reportar estado del servidor: peers, rooms, memoria, uptime, workers.",
      { type: "object", properties: {} },
      async () => {
        const report = buildHealthReport(this.rooms, this.wsServer);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      },
    );

    // ═══════════════════════════════════════════════════════
    // FASE 3 — VIDEO STREAMS
    // ═══════════════════════════════════════════════════════

    // ── connect_stream ────────────────────────────────────
    this._register(
      "webrtc_connect_stream",
      "Conectar a un stream de video RTSP/HLS. Devuelve un streamId para usar con frame_get y stream_status.",
      {
        type: "object",
        properties: {
          url: { type: "string", description: "URL del stream. Soporta rtsp://, rtmp://, .m3u8" },
          fps: { type: "integer", default: 1, description: "Frames por segundo (default: 1)" },
          quality: { type: "integer", default: 5, minimum: 1, maximum: 31, description: "Calidad JPEG (1-31, menor = mejor)" },
        },
        required: ["url"],
      },
      async (args) => {
        const url = String(args.url);
        const fps = Number(args.fps ?? 1);
        const quality = Number(args.quality ?? 5);
        const id = this.streams.connect(url, { fps, quality });
        const info = this.streams.getStreamInfo(id);
        return { content: [{ type: "text", text: JSON.stringify({ streamId: id, info }) }] };
      },
    );

    // ── frame_get ─────────────────────────────────────────
    this._register(
      "webrtc_frame_get",
      "Obtener el último frame de un stream de video como base64 JPEG. Usar con vision_analyze para analizar la escena.",
      {
        type: "object",
        properties: {
          streamId: { type: "string", description: "ID del stream (de connect_stream)" },
          includeData: { type: "boolean", default: true, description: "Incluir frame base64 en la respuesta" },
        },
        required: ["streamId"],
      },
      async (args) => {
        const streamId = String(args.streamId);
        const frame = this.streams.getFrame(streamId);
        if (!frame) {
          const info = this.streams.getStreamInfo(streamId);
          if (!info) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "Stream not found" }) }], isError: true };
          }
          return { content: [{ type: "text", text: JSON.stringify({ error: "No frames yet", info }) }] };
        }
        const result: any = {
          streamId: frame.streamId,
          timestamp: frame.timestamp,
          sequence: frame.sequence,
          resolution: { width: frame.width, height: frame.height },
          format: frame.format,
          sizeBytes: frame.data.length,
        };
        if (args.includeData !== false) {
          result.frame = frame.data.toString("base64");
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    );

    // ── stream_status ─────────────────────────────────────
    this._register(
      "webrtc_stream_status",
      "Obtener estado detallado de un stream de video: resolución, fps, frames capturados, errores.",
      {
        type: "object",
        properties: {
          streamId: { type: "string", description: "ID del stream" },
        },
        required: ["streamId"],
      },
      async (args) => {
        const info = this.streams.getStreamInfo(String(args.streamId));
        if (!info) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Stream not found" }) }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(info) }] };
      },
    );

    // ── list_streams ──────────────────────────────────────
    this._register(
      "webrtc_list_streams",
      "Listar todos los streams de video activos con su estado.",
      { type: "object", properties: {} },
      async () => {
        const streams = this.streams.listStreams();
        return { content: [{ type: "text", text: JSON.stringify({ streams, count: streams.length }) }] };
      },
    );

    // ── disconnect_stream ─────────────────────────────────
    this._register(
      "webrtc_disconnect_stream",
      "Desconectar y liberar un stream de video.",
      {
        type: "object",
        properties: {
          streamId: { type: "string", description: "ID del stream a desconectar" },
        },
        required: ["streamId"],
      },
      async (args) => {
        const ok = this.streams.disconnect(String(args.streamId));
        return { content: [{ type: "text", text: JSON.stringify({ success: ok }) }] };
      },
    );
  }
}
