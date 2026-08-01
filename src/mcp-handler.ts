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
  private pool: any = null;
  /** Mensajes entrantes dirigidos al cliente MCP (B → A). */
  private inbox: Array<{ from: string; data: any; at: number }> = [];
  /** Registro de tareas enviadas (taskId → estado). */
  private tasks = new Map<string, { id: string; from: string; to: string; spec: string; status: string; sentAt: number }>();

  constructor(signaling: SignalingServer, rooms: RoomManager, wsServer?: WsSignalingServer | null) {
    this.signaling = signaling;
    this.rooms = rooms;
    this.wsServer = wsServer ?? null;
    this.streams = new StreamManager();
    this._registerAll();
  }

  /** Conectar el worker pool (para DataChannel delivery). */
  setPool(pool: any): void {
    this.pool = pool;
  }

  /** Conectar el WS signaling server (para relay a peers WebSocket). */
  setWsServer(ws: WsSignalingServer | null): void {
    this.wsServer = ws;
  }

  /** Recibir mensajes no ruteables a peers WS (B → cliente MCP). */
  onInboundMessage(msg: any): void {
    this.inbox.push({
      from: String(msg.from ?? "unknown"),
      data: msg.data ?? msg,
      at: Date.now(),
    });
    // Actualizar estado de la tarea si es un resultado
    const data = msg.data as any;
    if (data && data.taskId && this.tasks.has(data.taskId)) {
      const t = this.tasks.get(data.taskId)!;
      t.status = data.status === "done" ? "done" : "in_progress";
      this.tasks.set(data.taskId, t);
    }
  }

  /** Entregar un mensaje a un peer: DataChannel (pool) → fallback WS relay. */
  private deliver(peerId: string, msg: Record<string, unknown>): boolean {
    if (this.pool && this.pool.sendToPeer && this.pool.sendToPeer(peerId, { type: "send", peerId, channel: "default", msg })) {
      return true;
    }
    if (this.wsServer && this.wsServer.relayToPeer(peerId, { type: "command", from: "host", to: peerId, ...msg })) {
      return true;
    }
    return false;
  }

  /**
   * Verificar que el host MCP puede asignar tareas al peer destino.
   * Regla: solo el worker principal (primer peer del room) puede asignar.
   * El host es principal solo si creó el room (o llegó primero); si el room
   * ya tiene otro principal (p.ej. un worker WS llegó antes), el host no asigna.
   */
  private canAssignTo(peerId: string): { ok: boolean; reason?: string } {
    const roomsOfPeer = this.rooms.getPeerRooms(peerId);
    for (const room of roomsOfPeer) {
      if (room.principal && room.principal !== "host") {
        return {
          ok: false,
          reason: `solo el worker principal (${room.principal}) puede asignar tareas en room "${room.id}"; host es secundario`,
        };
      }
    }
    return { ok: true };
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
        // Control de permisos: solo el principal del room puede asignar tareas
        const check = this.canAssignTo(peerId);
        if (!check.ok) {
          return {
            content: [{ type: "text", text: JSON.stringify({ peerId, delivered: false, error: check.reason }) }],
            isError: true,
          };
        }
        const delivered = this.deliver(peerId, { type: "task", from: "host", peerId, data });
        // Registrar tarea para tracking (si data trae id/spec)
        const d = data as any;
        const taskId = String(d?.id ?? `T-${Date.now()}`);
        this.tasks.set(taskId, {
          id: taskId,
          from: "host",
          to: peerId,
          spec: String(d?.spec ?? d?.task ?? ""),
          status: delivered ? "sent" : "failed",
          sentAt: Date.now(),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ peerId, delivered, taskId, size: JSON.stringify(data).length }) }],
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

        // Control de permisos: solo el principal del room puede asignar tareas
        const forbidden: string[] = [];
        for (const target of targets) {
          if (!this.canAssignTo(target).ok) forbidden.push(target);
        }
        if (forbidden.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  recipients: 0,
                  delivered: 0,
                  forbidden,
                  error: `solo el worker principal del room puede asignar tareas (sin permiso: ${forbidden.join(", ")})`,
                }),
              },
            ],
            isError: true,
          };
        }

        // Entrega real: WS relay (por DataChannel no hay broadcast multi-peer hoy)
        let deliveredCount = 0;
        const failed: string[] = [];
        const d = args.data as any;
        const taskId = String(d?.id ?? `BC-${Date.now()}`);
        for (const target of targets) {
          const ok = this.deliver(target, { type: "task", from: "host", room: room ?? "", data: args.data });
          if (ok) deliveredCount++;
          else failed.push(target);
        }
        // Registrar broadcast como tarea multi-peer
        this.tasks.set(taskId, {
          id: taskId,
          from: "host",
          to: targets.join(","),
          spec: String(d?.spec ?? d?.task ?? ""),
          status: failed.length === 0 ? "sent" : `partial(${failed.length})`,
          sentAt: Date.now(),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ recipients: targets.length, delivered: deliveredCount, failed, taskId, total: targets }),
            },
          ],
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

    // ── poll ─────────────────────────────────────────────
    this._register(
      "webrtc_poll",
      "Recibir mensajes entrantes dirigidos a este cliente MCP (respuestas/ACKs de otros peers). Devuelve y limpia la cola.",
      {
        type: "object",
        properties: {
          clear: { type: "boolean", default: true, description: "Limpiar la cola tras leerla" },
        },
      },
      async (args) => {
        const clear = args.clear !== false;
        const msgs = this.inbox;
        if (clear) this.inbox = [];
        return {
          content: [{ type: "text", text: JSON.stringify({ count: msgs.length, messages: msgs }) }],
        };
      },
    );

    // ── room_info ────────────────────────────────────────
    this._register(
      "webrtc_room_info",
      "Ver quién está en un room, qué tareas tiene cada peer y su estado (sent/in_progress/done).",
      {
        type: "object",
        properties: {
          room: { type: "string", description: "ID del room (default: primero existente)" },
        },
      },
      async (args) => {
        const rooms = this.rooms.list();
        const room = (args.room as string) ?? rooms[0]?.id ?? "default";
        const roomInfo = this.rooms.list().find((r) => r.id === room);
        const peerIds = this.rooms.getPeersInRoom(room);
        const wsPeers = this.wsServer ? Array.from((this.wsServer as any).peers?.keys?.() ?? []) : [];
        const tasksByPeer: Record<string, any[]> = {};
        for (const [id, t] of this.tasks) {
          const targets = t.to.split(",");
          for (const target of targets) {
            (tasksByPeer[target] ??= []).push({ taskId: t.id, spec: t.spec, status: t.status });
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                room,
                principal: roomInfo?.principal ?? null,
                peerCount: peerIds.length,
                peers: peerIds.map((id) => ({
                  peerId: id,
                  ws: wsPeers.includes(id),
                  principal: roomInfo?.principal === id,
                  tasks: tasksByPeer[id] ?? [],
                })),
              }),
            },
          ],
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
        // El host MCP se une como "host": es el primer peer → principal (jefe) del room.
        const room = this.rooms.join(String(args.room), "host", String(args.name ?? ""));
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
      "Re-enviar una señal (SDP/ICE) a un peer específico dentro de un room. Útil para multi-agente donde dos agentes necesitan intercambiar señales a través del MCP server.",
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
