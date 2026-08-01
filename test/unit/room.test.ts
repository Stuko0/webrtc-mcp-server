import { describe, it, expect } from "vitest";
import { RoomManager } from "../../src/signaling/room.js";

const mockConfig = {
  limits: { maxRooms: 100, maxPeersPerRoom: 32, maxPeersPerWorker: 16, maxMessageRate: 1000 },
  maxWorkers: 8,
  connectionTimeoutMs: 30000,
  iceRestartMaxRetries: 3,
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  dataChannel: { maxRetries: 5, retryBackoffMs: 1000, maxMessageSize: 262144 },
  signaling: { mode: "stdio" as const, wsPort: 8765, wsHost: "127.0.0.1" },
  logging: { level: "info" as const },
};

describe("RoomManager", () => {
  it("creates a room on first join", () => {
    const rm = new RoomManager(mockConfig);
    const room = rm.join("dev", "alice");
    expect(room.id).toBe("dev");
    expect(room.peers).toEqual(["alice"]);
  });

  it("adds peers to existing room", () => {
    const rm = new RoomManager(mockConfig);
    rm.join("dev", "alice");
    const room = rm.join("dev", "bob");
    expect(room.peers).toEqual(["alice", "bob"]);
  });

  it("lists all rooms", () => {
    const rm = new RoomManager(mockConfig);
    rm.join("dev", "alice");
    rm.join("staging", "bob");
    expect(rm.list()).toHaveLength(2);
  });

  it("gets peers in a room excluding a peer", () => {
    const rm = new RoomManager(mockConfig);
    rm.join("dev", "alice");
    rm.join("dev", "bob");
    rm.join("dev", "charlie");
    expect(rm.getPeersInRoom("dev", "alice")).toEqual(["bob", "charlie"]);
    expect(rm.getPeersInRoom("dev")).toEqual(["alice", "bob", "charlie"]);
  });

  it("deletes room when last peer leaves", () => {
    const rm = new RoomManager(mockConfig);
    rm.join("dev", "alice");
    rm.leave("dev", "alice");
    expect(rm.list()).toHaveLength(0);
  });

  it("throws when room is full", () => {
    const rm = new RoomManager({ ...mockConfig, limits: { ...mockConfig.limits, maxPeersPerRoom: 1 } });
    rm.join("dev", "alice");
    expect(() => rm.join("dev", "bob")).toThrow("Room dev full");
  });

  it("throws when max rooms reached", () => {
    const rm = new RoomManager({ ...mockConfig, limits: { ...mockConfig.limits, maxRooms: 1 } });
    rm.join("a", "alice");
    expect(() => rm.join("b", "bob")).toThrow("Max rooms");
  });

  it("lists rooms for a peer", () => {
    const rm = new RoomManager(mockConfig);
    rm.join("dev", "alice");
    rm.join("ops", "alice");
    expect(rm.getPeerRooms("alice")).toHaveLength(2);
    rm.leave("dev", "alice");
    expect(rm.getPeerRooms("alice")).toHaveLength(1);
  });
});
