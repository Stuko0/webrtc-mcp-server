// --- Constructors (importados dinámicamente de wrtc) ---
export interface WebRTCGlobals {
  RTCPeerConnection: any;
  RTCSessionDescription: any;
  RTCIceCandidate: any;
}

// --- Tipos ---
export type RTCConfiguration = {
  iceServers: RTCIceServer[];
  iceCandidatePoolSize?: number;
  iceTransportPolicy?: "all" | "relay";
};

export type RTCIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type RTCSessionDescriptionInit = {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp: string;
};

export type RTCIceCandidateInit = {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
};

export interface RTCDataChannel {
  label: string;
  readyState: "connecting" | "open" | "closing" | "closed";
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

// --- Estado de conexión ---
export type PeerConnectionState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

// --- Lazy loader para wrtc ---
let _wrtc: WebRTCGlobals | null = null;

export function loadWebRTC(): WebRTCGlobals {
  if (_wrtc) return _wrtc;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@roamhq/wrtc");
    _wrtc = {
      RTCPeerConnection: mod.RTCPeerConnection,
      RTCSessionDescription: mod.RTCSessionDescription,
      RTCIceCandidate: mod.RTCIceCandidate,
    };
    return _wrtc;
  } catch (err) {
    throw new Error(
      `Failed to load @roamhq/wrtc: ${err instanceof Error ? err.message : String(err)}. ` +
      "Install it with: npm install @roamhq/wrtc"
    );
  }
}
