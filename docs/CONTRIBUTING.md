# Contributing to WebRTC MCP Server

¡Gracias por tu interés en contribuir! Este proyecto sigue buenas prácticas de TypeScript con Node.js.

## Setup de desarrollo

```bash
git clone https://github.com/Stuko0/webrtc-mcp-server.git
cd webrtc-mcp-server
npm install
npm run build
```

## Comandos

| Comando | Descripción |
|---|---|
| `npm run build` | Compila TypeScript → `dist/` |
| `npm run dev` | Watch mode con `tsx` |
| `npm test` | Ejecuta tests (vitest) |
| `npm run typecheck` | Verificación de tipos (`tsc --noEmit`) |
| `npm run lint` | ESLint |
| `npm run fmt` | Prettier |

## Estructura de código

```
src/
├── index.ts              # Entry point: MCP loop + worker pool + WS bridge
├── mcp-handler.ts        # MCP Protocol v2025-03-26 handler
├── config.ts             # Environment config + validation
├── types.ts              # TypeScript interfaces
├── signaling/
│   ├── server.ts         # DataChannel signaling
│   ├── ws-server.ts      # WebSocket signaling server
│   └── room.ts           # RoomManager (peer management)
├── workers/
│   ├── pool.ts           # Worker Thread pool (spawn/assign/resize)
│   └── worker-instance.ts # RTCPeerConnection + DataChannel per worker
└── video/
    ├── ffmpeg-bridge.ts  # RTSP/HLS → frames
    ├── frame-cache.ts    # Thread-safe ring buffer
    ├── stream-manager.ts # Orchestrator
    └── types.ts          # Stream types
```

## Principios de diseño

1. **Zero core footprint** — el server es un proceso externo (MCP), no modifica el host del cliente
2. **Idempotencia** — `graphify-out/` y `dist/` se ignoran en `.gitignore`
3. **Thread safety** — el worker pool y frame cache usan mutexes
4. **Auto-recuperación** — los workers se reinician automáticamente tras crash
5. **Tests** — agregar test para toda funcionalidad nueva

## Pull Requests

- Tests deben pasar: `npm test`
- Typecheck limpia: `npm run typecheck`
- Lint: `npm run lint`
- Documentar nuevas herramientas en `README.md` → sección "MCP Tools"

## Estilo de código

- TypeScript estricto (no `any` sin justificación)
- Imports: `@/` alias a `src/`
- Tests: `test/` directory, vitest
- Commits: [Conventional Commits](https://www.conventionalcommits.org/)
