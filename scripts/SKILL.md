---
name: webrtc-monitoring
description: "Monitoreo en tiempo real vía WebRTC MCP."
version: 1.0.0
author: stuko
license: MIT
platforms: [linux, macos]
metadata:
  lydia:
    tags: [webrtc, monitoring, real-time, video, streaming, multi-agent]
    category: productivity
    related_skills: [google-workspace, cronjob]
---

# WebRTC Monitoring Skill

## Descripción
Permite que Lydia se conecte a fuentes de video en tiempo real (cámaras RTSP, streams HLS) y a otros agentes (OpenCode, Claude Code) vía WebRTC DataChannels para comunicación multi-agente de baja latencia.

Requiere el servidor MCP `webrtc-mcp-server` corriendo.

## Prerrequisitos
- MCP server `webrtc` instalado y corriendo vía `lydia mcp install`
- Node.js >= 20
- ffmpeg en PATH (para streams de video)
- Para multi-agente: el otro agente debe tener acceso al mismo WebSocket signaling

## Instalación

```bash
# 1. Construir el server (si no está hecho)
cd ~/Jobs/Arquant/webrtc-mcp-server
npm install && npm run build

# 2. Instalar en Lydia como MCP server
lydia mcp install webrtc \
  --command node \
  --args "/home/stuko/Jobs/Arquant/webrtc-mcp-server/dist/index.js" \
  --env "WEBRTC_MAX_WORKERS=8,WEBRTC_LOG_LEVEL=info"

# 3. Verificar
lydia mcp list
lydia mcp call webrtc webrtc_health
```

## Uso

### 1. Conectar a una cámara RTSP
```
> Conectate a la cámara en rtsp://admin:pass@192.168.1.100:554/stream1
→ Lydia llama webrtc_connect_stream(url="rtsp://...", fps=2)
→ Lydia llama webrtc_frame_get(streamId)
→ Lydia pasa el frame a vision_analyze
→ Lydia responde con análisis
```

### 2. Monitoreo periódico (cron)
```
> Cada 5 minutos, revisá la cámara de la entrada y decime si hay movimiento
→ Lydia crea cronjob:
   cronjob(action='create', schedule='every 5m',
           prompt='Conectate a rtsp://admin:pass@192.168.1.100:554/stream1,
                   obtené un frame con frame_get, pasalo a vision_analyze
                   preguntando "¿Hay alguien en la escena?",
                   y si hay personas, enviame un mensaje.',
           skills=['webrtc-monitoring'],
           enabled_toolsets=['mcp'])
```

### 3. Multi-agente (Lydia ↔ OpenCode)
```
> Conectate con OpenCode en el room "dev" y preguntale si terminó el code review
→ Lydia: webrtc_join_room(room="dev", peerId="lydia")
→ OpenCode: webrtc_join_room(room="dev", peerId="opencode")
→ Lydia: webrtc_signal_relay(to="opencode", type="offer", sdp=...)
→ OpenCode: webrtc_signal_relay(to="lydia", type="answer", sdp=...)
→ Lydia: webrtc_send(peerId="opencode", data={type:"command", action:"review_status"})
→ OpenCode responde por DataChannel
```

### 4. Broadcast a múltiples agentes
```
> Enviale este mensaje a todos los agentes en el room
→ Lydia llama webrtc_broadcast(data={type:"notification", text:"Nuevo deploy"}, room="dev")
```

## Referencia rápida

| Comando | Ejemplo |
|---------|---------|
| Conectar stream | `webrtc_connect_stream(url="rtsp://...", fps=5)` |
| Obtener frame | `webrtc_frame_get(streamId="abc123")` |
| Health check | `webrtc_health` |
| Crear room | `webrtc_create_room(room="dev", name="Equipo Dev")` |
| Unir peer | `webrtc_join_room(room="dev", peerId="lydia")` |
| Señal relay | `webrtc_signal_relay(to="opencode", type="offer", sdp=...)` |
| Enviar mensaje | `webrtc_send(peerId="opencode", data={...})` |
| Broadcast | `webrtc_broadcast(data={...}, room="dev")` |

## Pitfalls

- **ffmpeg no instalado**: `webrtc_connect_stream` falla si ffmpeg no está en PATH.
  Instalar con `sudo apt install ffmpeg` o `brew install ffmpeg`.
- **Streams RTSP requieren TCP**: Algunas cámaras no soportan UDP.
  El bridge fuerza `-rtsp_transport tcp`.
- **Multi-agente necesita WS signaling**: Para conectar Lydia con OpenCode,
  iniciar el server con `WEBRTC_SIGNALING_MODE=both`.
- **Frame demasiado grande**: `frame_get` puede devolver >500KB por frame.
  Usar `quality=15` para reducir tamaño si el contexto es limitado.

## Verification

- [ ] `lydia mcp list` muestra `webrtc` como running
- [ ] `webrtc_health` devuelve `status: "healthy"`
- [ ] `webrtc_list_peers` devuelve lista de peers
- [ ] `webrtc_create_room + webrtc_join_room + webrtc_leave_room` funciona
- [ ] `webrtc_connect_stream + webrtc_frame_get` funciona (si hay ffmpeg)
