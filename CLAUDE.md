# CLAUDE.md

## Project Overview

CC LINE Ollama — LINE Bot ที่ใช้ Ollama (local LLM) ผ่าน Claude Code Agent SDK. 4-container architecture: Ollama engine + Claude Code server + LINE bot + Cloudflare tunnel.

## Commands

```bash
# Docker deployment
docker compose up -d --build
docker exec cc-ollama-engine ollama pull qwen3:8b    # Pull model (first run)

# Logs
docker logs cc-ollama-engine --tail 30       # Ollama engine
docker logs cc-ollama-server --tail 30       # Claude Code server
docker logs cc-ollama-line-bot --tail 30     # LINE bot
docker logs cc-ollama-tunnel                 # Tunnel URL

# Health check
docker exec cc-ollama-line-bot curl -s http://server:4096/health

# List pulled models
docker exec cc-ollama-engine ollama list
```

## Architecture

```
LINE app → Cloudflare Tunnel → line-bot (Bun, port 3000)
  ↕ HTTP fetch → http://server:4096
server (Hono + Claude Agent SDK, port 4096)
  ↕ query() → Claude Code CLI (bundled in SDK)
  ↕ ANTHROPIC_BASE_URL=http://ollama:11434
ollama (port 11434) → qwen3:8b
```

### 4 Containers

| Container | Image | Role |
|-----------|-------|------|
| `cc-ollama-engine` | `ollama/ollama:latest` | Local LLM inference |
| `cc-ollama-server` | `./server` (node:22-slim + bun + SDK) | Claude Code API server |
| `cc-ollama-line-bot` | `.` (oven/bun:1 + @line/bot-sdk) | LINE webhook handler |
| `cc-ollama-tunnel` | cloudflare/cloudflared | Expose bot to internet |

## Key Files

- **`src/index.ts`** — LINE bot: webhook, signature validation, message chunking, commands, HTTP client to server
- **`server/src/index.ts`** — Hono API server (routes, SSE, auth)
- **`server/src/claude.ts`** — Claude Agent SDK wrapper (query() AsyncGenerator)
- **`server/src/session.ts`** — In-memory session manager
- **`server/src/events.ts`** — Event bus for SSE

## Key Design

- **Ollama in Docker**: No host dependency — Ollama runs as a Docker container, server connects via `http://ollama:11434`
- **Swappable server**: Bot calls server via `SERVER_URL` env — can point to claude-code-server, opencode-server, or any compatible API
- **Server API**: `POST /session` (create), `POST /session/:id/message` (prompt), `POST /session/:id/abort` (cancel), `DELETE /session/:id` (cleanup)
- **Per-user sessions**: Each LINE user gets their own server session
- **Per-user queue**: Messages from same user are serialized
- **Message chunking**: LINE 5000 char limit — long responses split with code block balancing

## LINE Bot Commands

- Any text → forwarded to Claude Code (via Ollama)
- `/new` — Clear session, start fresh
- `/abort` — Cancel active prompt
- `/sessions` — Show session info + cost
- `/cost` — Show total cost

## Environment Variables

### Bot (line-bot container)
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | - | LINE channel access token |
| `LINE_CHANNEL_SECRET` | Yes | - | LINE channel secret |
| `SERVER_URL` | No | `http://server:4096` | Server API URL |
| `SERVER_PASSWORD` | No | - | Server auth (Bearer token) |
| `PROMPT_TIMEOUT_MS` | No | `300000` | Timeout per prompt (5 min) |

### Server (server container)
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_AUTH_TOKEN` | - | `ollama` | Hardcoded in docker-compose |
| `ANTHROPIC_BASE_URL` | - | `http://ollama:11434` | Hardcoded in docker-compose |
| `API_PASSWORD` | No | - | API auth password |
| `CLAUDE_MODEL` | No | `qwen3:8b` | Ollama model |
| `CLAUDE_MAX_TURNS` | No | `10` | Max agentic turns |
| `CLAUDE_MAX_BUDGET_USD` | No | `1.00` | Max spend per prompt |

## Gotchas

- **Must pull model first**: After `docker compose up`, run `docker exec cc-ollama-engine ollama pull qwen3:8b`
- Tunnel URL changes on restart — update LINE webhook URL
- Bot talks to server via Docker internal DNS (`http://server:4096`)
- Server talks to Ollama via Docker internal DNS (`http://ollama:11434`)
- Response speed depends on hardware (CPU vs GPU) — GPU strongly recommended
- `ollama-models` volume can be large (several GB per model)
- `API_PASSWORD` env is shared between bot (`SERVER_PASSWORD`) and server (`API_PASSWORD`)
