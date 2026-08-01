import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SignalingServer } from "../../src/signaling/server.js";

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

describe("SignalingServer", () => {
  let ss: SignalingServer;

  beforeEach(() => {
    ss = new SignalingServer(mockConfig);
  });

  it("creates an offer for a peer", () => {
    const offer = ss.createOffer("alice", "test");
    expect(offer.type).toBe("offer");
    expect(offer.from).toBe("server");
    expect(offer.to).toBe("alice");
    expect(offer.label).toBe("test");
  });

  it("queues pending signals", () => {
    ss.createOffer("alice");
    ss.createOffer("alice");
    const signals = ss.dequeueSignals("alice");
    expect(signals).toHaveLength(2);
    // Second dequeue is empty
    expect(ss.dequeueSignals("alice")).toHaveLength(0);
  });

  it("processes answer from a peer", () => {
    const answer = ss.processAnswer("bob", "sdp-data");
    expect(answer.type).toBe("answer");
    expect(answer.from).toBe("bob");
    expect(answer.sdp).toBe("sdp-data");
  });

  it("routes ICE candidate to specific peer", () => {
    const signals: any[] = [];
    ss.on("signal", (s) => signals.push(s));
    ss.routeIceCandidate("alice", { candidate: "cand", sdpMid: "0", sdpMLineIndex: 0 }, "bob");
    expect(signals).toHaveLength(1);
    expect(signals[0].to).toBe("bob");
    expect(signals[0].type).toBe("ice_candidate");
  });

  it("creates ICE restart signal", () => {
    const restart = ss.iceRestart("alice");
    expect(restart.type).toBe("ice_restart");
    expect(restart.to).toBe("alice");
  });

  it("handles join/leave room signals", () => {
    const signals: any[] = [];
    ss.on("signal", (s) => signals.push(s));

    ss.joinRoom("alice", "room1");
    expect(signals[0].type).toBe("join");
    expect(signals[0].from).toBe("alice");

    ss.leaveRoom("alice", "room1");
    expect(signals[1].type).toBe("leave");
    expect(signals[1].from).toBe("alice");
  });
});
