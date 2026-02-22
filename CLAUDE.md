# CLAUDE.md

## Project Overview

CC LINE Ollama — LINE Bot ที่ใช้ Claude Code CLI + Ollama (local LLM). Two Docker services: LINE bot (Bun + Claude Code CLI), Cloudflare tunnel. Ollama runs on the host machine.

## Commands

```bash
# Docker deployment
docker compose up -d --build
docker logs cc-ollama-line-bot --tail 30    # Bot logs
docker logs cc-ollama-tunnel                # Tunnel URL

# Local development
cp .env.example .env
bun install
bun dev
```

## Architecture

```
LINE app → Cloudflare Tunnel → line-bot (Bun, port 3000) → Claude Code CLI → Ollama Proxy (port 11435) → Ollama (host, port 11434)
```

- **`src/index.ts`** — LINE webhook handler + Ollama proxy + Claude Code subprocess runner
- **`Dockerfile`** — Node 22 + Bun + Claude Code CLI (`@anthropic-ai/claude-code`)
- **`docker-compose.yml`** — 2 services (line-bot, cloudflared)

## Key Design

**Claude Code CLI as subprocess:** `Bun.spawn(["claude", "-p", prompt, "--model", "qwen3:8b", "--output-format", "json", ...])`. Each user gets their own session via `--resume sessionId`.

**Ollama Proxy:** Built-in Bun HTTP server on port 11435 that proxies requests to Ollama (host:11434). Needed because Claude Code adds `?beta=true` query params that Ollama doesn't support. Also fakes `/count_tokens` endpoint.

**Environment vars for Ollama mode:**
- `ANTHROPIC_AUTH_TOKEN=ollama` — tells Claude Code to use custom auth
- `ANTHROPIC_BASE_URL=http://localhost:11435` — points at local proxy
- `ANTHROPIC_API_KEY` is deleted from env

**Non-root user:** Claude Code CLI refuses `--dangerously-skip-permissions` as root, so Dockerfile creates a `claude` user.

## Gotchas

- Ollama must run on host machine (not in Docker Compose) — bot connects via `host.docker.internal`
- `--dangerously-skip-permissions` is required — Claude Code CLI prompts for permissions interactively which blocks subprocess
- Per-user request queue prevents concurrent `claude` processes for same user
- Session resume: if `--resume` fails (expired), auto-retries once without it
- Claude Code CLI stores session data in `/home/claude/.claude` (persisted via `claude-data` volume)
