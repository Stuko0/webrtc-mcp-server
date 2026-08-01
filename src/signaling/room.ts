import { nanoid } from "nanoid";
import type { RoomInfo, ServerConfig } from "../types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("rooms");

export class RoomManager {
  private rooms = new Map<string, RoomInfo>();
  private peerToRooms = new Map<string, Set<string>>();
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /** Crear o unirse a un room. El primer peer en unirse se vuelve principal (jefe). */
  join(roomId: string, peerId: string, name?: string): RoomInfo {
    let room = this.rooms.get(roomId);
    if (!room) {
      if (this.rooms.size >= this.config.limits.maxRooms) {
        throw new Error(`Max rooms (${this.config.limits.maxRooms}) reached`);
      }
      room = { id: roomId, name: name ?? roomId, peers: [], createdAt: Date.now() };
      this.rooms.set(roomId, room);
    }

    if (!room.peers.includes(peerId)) {
      if (room.peers.length >= this.config.limits.maxPeersPerRoom) {
        throw new Error(`Room ${roomId} full (max ${this.config.limits.maxPeersPerRoom})`);
      }
      room.peers.push(peerId);
    }

    // El primer peer que se une al room es el principal (jefe)
    if (!room.principal) {
      room.principal = peerId;
      logger.info("room principal assigned", { roomId, principal: peerId });
    }

    const set = this.peerToRooms.get(peerId) ?? new Set();
    set.add(roomId);
    this.peerToRooms.set(peerId, set);

    logger.info("peer joined room", { roomId, peerId });
    return room;
  }

  /** Salir de un room. */
  leave(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.peers = room.peers.filter((p) => p !== peerId);

    // Si el principal se va, promover al siguiente peer más antiguo
    if (room.principal === peerId && room.peers.length > 0) {
      room.principal = room.peers[0];
      logger.info("room principal promoted", { roomId, principal: room.principal });
    }

    if (room.peers.length === 0) {
      this.rooms.delete(roomId);
      logger.info("room deleted (empty)", { roomId });
    }

    const set = this.peerToRooms.get(peerId);
    if (set) {
      set.delete(roomId);
      if (set.size === 0) this.peerToRooms.delete(peerId);
    }
  }

  /** ¿Es este peer el principal (jefe) del room? */
  isPrincipal(roomId: string, peerId: string): boolean {
    const room = this.rooms.get(roomId);
    return room?.principal === peerId;
  }

  /** Obtener el principal de un room. */
  getPrincipal(roomId: string): string | undefined {
    return this.rooms.get(roomId)?.principal;
  }

  /** Obtener todos los peers en un room (excepto el que pregunta). */
  getPeersInRoom(roomId: string, exclude?: string): string[] {
    return this.rooms.get(roomId)?.peers.filter((p) => p !== exclude) ?? [];
  }

  /** Listar rooms de un peer. */
  getPeerRooms(peerId: string): RoomInfo[] {
    const roomIds = this.peerToRooms.get(peerId);
    if (!roomIds) return [];
    return Array.from(roomIds).map((id) => this.rooms.get(id)).filter(Boolean) as RoomInfo[];
  }

  /** Listar todos los rooms. */
  list(): RoomInfo[] {
    return Array.from(this.rooms.values());
  }
}
