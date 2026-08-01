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

  /** Crear o unirse a un room. */
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
