# WebRTC MCP Server — Roadmap de Mejora

## Estado actual: v0.5.0 (19/08/2026)

| Componente | Estado |
|---|---|
| MCP Protocol Handler | ✅ Completo (v2025-03-26) |
| Peer Communication (DataChannels) | ✅ Completo — conexiones WebRTC REALES en hilo principal (WebRTCConnectionManager) |
| Rooms (join/leave/broadcast) | ✅ Completo |
| WebSocket Signaling | ✅ Completo (señales host↔peer vía onUndelivered) |
| Video Streams (FFmpeg bridge) | ✅ Completo |
| Worker Thread Pool | ⚠️ Solo tareas CPU-bound (@roamhq/wrtc no es thread-safe) |
| Frame Cache (ring buffer) | ✅ Completo |
| Tests | ✅ 18/18 passing |

---

## Próximas iteraciones

### v0.5.0 — TURN & NAT Traversal (3 días)
- [ ] STUN/TURN server configuration in `config.yaml`
- [ ] ICE candidate gathering with `iceRestart`
- [ ] NAT type detection (cone/symmetric)
- [ ] Fallback to relay when P2P fails

### v0.6.0 — Screen Capture (5 días)
- [ ] Electron `desktopCapturer` integration
- [ ] Screen sharing via WebRTC from desktop app
- [ ] Permission handler updates (`videoCapture` en Electron main)
- [ ] macOS entitlements: `com.apple.security.device.camera`

### v0.7.0 — Push Notifications (3 días)
- [ ] MCP server-initiated notifications (server→client)
- [ ] Frame push mode: `on_frame.callback: "notification"`
- [ ] Rate limiting: max 10 fps push, configurable
- [ ] Backward-compatible with polling mode

### v0.8.0 — Load Testing (2 días)
- [ ] Artillery + k6 load tests (16 concurrent streams)
- [ ] Latency regression tests (<500ms p95)
- [ ] Memory leak detection (worker threads)
- [ ] Performance dashboard

### v0.9.0 — Production Hardening (4 días)
- [ ] Graceful shutdown (drain workers, close peer connections)
- [ ] Health check endpoint (`/health` HTTP)
- [ ] Metrics: Prometheus exporter (peers, streams, workers)
- [ ] Logging: structured JSON with trace IDs
- [ ] Config validation with Zod schemas

### v1.0.0 — npm Publish (1 día)
- [ ] Publish `webrtc-mcp-server` on npm
- [ ] MCP catalog submission
- [ ] Documentation site (Docusaurus)
- [ ] Example projects: MCP client integration, WebSocket peer client

---

## Mejoras de infraestructura

### Seguridad
- [ ] URL allowlist en `connect_stream` (evitar SSRF)
- [ ] Credential redaction en logs (truncar passwords en URLs RTSP)
- [ ] TLS/WSS support para signaling WebSocket
- [ ] Rate limiting por peer (default: 1000 msg/s)

### Rendimiento
- [ ] Frame compression: WebP option (smaller than JPEG)
- [ ] Hardware acceleration: NVENC para encoding (NVIDIA GPU)
- [ ] Multi-codec: H.264, VP8, VP9 selection
- [ ] Adaptive bitrate: ajustar calidad según ancho de banda

### Observabilidad
- [ ] OpenTelemetry tracing (WebRTC connections, FFmpeg bridge)
- [ ] Metrics: frames decoded/sec, bytes in/out, peer count
- [ ] Error boundary: capturar y reportar errores de FFmpeg

---

## Cómo contribuir

1. Fork el repositorio
2. `npm install && npm run build`
3. Crear branch: `git checkout -b feat/nueva-caracteristica`
4. Tests: `npm test`
5. Pull request con descripción clara

Ver [CONTRIBUTING.md](CONTRIBUTING.md) para detalles.
