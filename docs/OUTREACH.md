# Outreach Plan — webrtc-mcp-server

Plan de difusión para dar a conocer el MCP server. Ordenado por impacto/ratio esfuerzo.

---

## 1. Directorios de MCP servers (impacto alto, esfuerzo bajo)

| # | Canal | Estado | Acción |
|---|-------|--------|--------|
| 1 | [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) (91.7k★) | ⏳ PR enviado | PR a README con entry en sección adecuada. Añadir `🤖🤖🤖` al título = fast-track merge |
| 2 | [Glama](https://glama.ai/mcp/servers) | ✅ Auto-indexado | Verificar perfil: `glama.ai/mcp/servers/webrtc-mcp-server` — claim y completar metadata |
| 3 | [mcp.so](https://mcp.so) | ⏳ | Crear cuenta + submit server (formulario con repo, tags, descripción) |
| 4 | [PulseMCP](https://www.pulsemcp.com) | ⏳ | Submit a directory + **subir a su newsletter** (foco: "MCP server de la semana") |
| 5 | [Smithery](https://smithery.ai) | ⏳ | Registro + deploy gratis (hosting del server) |
| 6 | [MCP Registry](https://mcpregistry.com) | ⏳ | Submit manual |
| 7 | [mcpservers.org](https://mcpservers.org) | ⏳ | Submit manual |

## 2. Comunidades (impacto alto, esfuerzo medio)

| # | Comunidad | Acción |
|---|-----------|--------|
| 1 | **r/ModelContextProtocol** (oficial MCP) | Post "Show and Tell" con demo (vídeo corto de 2 agentes hablando) |
| 2 | **r/LocalLLaMA** | Post técnico — comparativa con otros transports (HTTP, stdio) |
| 3 | **Hacker News** — Show HN | "Show HN: WebRTC MCP Server — P2P data channels between AI agents" (mejor día: martes-jueves, 9-11am ET) |
| 4 | **Discord oficial MCP** (modelcontextprotocol.io/discord) | Post en #showcase / #servers |
| 5 | **Dev.to / Medium** | Tutorial: "Conecta 2 agentes de IA con WebRTC" (paso a paso + código) |

## 3. Creadores de contenido (impacto alto, esfuerzo medio — DMs)

### Ingleses (mayor alcance)
| Creador | Plataforma | Por qué | Pitch |
|---------|-----------|---------|-------|
| **Simon Willison** (@simonw) | Blog/Bluesky | El referente #1 de herramientas LLM; cubre cada MCP server notable | "WebRTC MCP server — P2P DataChannels entre agentes. No hay nada similar" |
| **Theo** (t3.gg, @theo) | YouTube/X | Dev streamer, cubre herramientas de IA para devs | Demo corta de multi-agente |
| **Fireship** (@fireship_dev) | YouTube (2.8M) | Videos cortos de trends — hizo el video intro de MCP | "MCP en 100 segundos" → mencionar servers notables |
| **Matt Pocock** (@mattpocockuk) | X/YouTube | TypeScript + IA | Ángulo: TS, worker threads, WebRTC |
| **Kev** (kev mods) | X/YouTube | Cubre MCP servers nuevos frecuentemente | Demo directa |

### Newsletters (impacto compuesto)
| Newsletter | Acción |
|-----------|--------|
| **Ben's Bites** (@bensbites) | Submit "open source project" form |
| **TLDR AI / TLDR Dev** | Submit form (alcanza 1.5M+ devs) |
| **AI Engineer Newsletter** | Submit |
| **This Week in MCP** (si existe aún) | Submit |

### Españoles/latam (por si quieres audiencia local)
| Creador | Plataforma | Por qué |
|---------|-----------|--------|
| **midudev** | YouTube/Twitch | El dev streamer hispano más grande; cubre IA |
| **CodelyTV** | YouTube | Formación dev España |
| **Fazt** | YouTube | Audiencia latam dev |

## 4. Demo / Material de marketing (hacer ANTES de difundir)

- [ ] **Video demo 30-60s**: dos agentes (Claude Code ↔ OpenCode) intercambiando mensajes vía DataChannels
- [ ] **Screenshot del grafo** (graphify-out/graph.html) para visual
- [ ] **GIF del flujo**: `webrtc_connect` → `send` → respuesta
- [ ] Un **post de X** con el hook: *"Your AI agents can't talk to each other. Mine can."*
- [ ] Badge de npm ya en README ✅

## 5. Mantenimiento

- Responder issues/PRs rápido (primeros días críticos)
- Subir a v0.5.0 (TURN, screen capture) y anunciarlo como "major update"
- Publicar release notes en GitHub Releases por cada tag
- Añadir el repo a tu portfolio (stuko.dev) con el badge "published on npm"

## Checklist de ejecución

- [x] Publicar en npm
- [x] CI verde (Node 20/22)
- [ ] PR a awesome-mcp-servers
- [ ] Registrar en mcp.so, PulseMCP, Smithery, MCP Registry
- [ ] Post en r/ModelContextProtocol + r/LocalLLaMA
- [ ] Show HN
- [ ] DMs a creadores (simonw, theo, matt pocock, bensbites)
- [ ] Video demo 30-60s
