# CC LINE Ollama

LINE Bot ที่ใช้ **Claude Code CLI** + **Ollama** (local LLM) — รัน AI agent บนเครื่องตัวเอง ฟรี 100%

## Architecture

```
LINE app → Cloudflare Tunnel → line-bot (Bun + Claude Code CLI) → Ollama Proxy → Ollama (host, port 11434)
```

2 Docker services:
- **line-bot** — Bun HTTP server + Claude Code CLI + Ollama proxy (strips `?beta=true`)
- **cloudflared** — Cloudflare tunnel for HTTPS

Claude Code CLI ใช้ Ollama เป็น backend โดย:
1. Bot สร้าง proxy (port 11435) ที่ strip query params ที่ Ollama ไม่รองรับ
2. ตั้ง `ANTHROPIC_AUTH_TOKEN=ollama` + `ANTHROPIC_BASE_URL=http://localhost:11435`
3. Claude Code CLI spawn subprocess แล้วส่ง prompt ไปยัง Ollama ผ่าน proxy

## Prerequisites

- **Ollama ต้องรันบนเครื่อง host** (ไม่ได้อยู่ใน Docker Compose)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull model
ollama pull qwen3:8b
```

## Setup

1. สร้าง LINE Messaging API channel ที่ https://developers.line.biz/console/

2. ตั้งค่า environment:
```bash
cp .env.example .env
# แก้ไข .env:
# - LINE_CHANNEL_ACCESS_TOKEN=your-token
# - LINE_CHANNEL_SECRET=your-secret
# - CLOUDFLARE_TUNNEL_TOKEN=your-tunnel-token
```

3. Deploy:
```bash
docker compose up -d --build
```

4. ดู tunnel URL แล้วตั้งใน LINE Developer Console:
```bash
docker logs cc-ollama-tunnel
# Set webhook URL: https://your-tunnel.trycloudflare.com/webhook
```

## Changing Models

```bash
# Pull model ใหม่บน host
ollama pull llama3.1:8b

# แก้ .env
CLAUDE_MODEL=llama3.1:8b

# Restart bot
docker compose up -d --build
```

Popular models:
- `qwen3:8b` (default) — fast, good quality
- `llama3.1:8b` — general purpose
- `deepseek-coder-v2:16b` — strong coding
- `codellama:13b` — coding focused

## Commands

| Command | Description |
|---------|-------------|
| `/new` | เริ่ม session ใหม่ |
| `/abort` | ยกเลิก prompt ที่กำลังทำ |
| `/sessions` | ดูสถานะ session |
| `/about` (`/who`) | แนะนำตัว bot |
| `/help` (`/คำสั่ง`) | คำสั่งทั้งหมด |

## Docker Commands

```bash
# Build and deploy
docker compose up -d --build

# Logs
docker logs cc-ollama-line-bot --tail 30     # LINE bot + Claude Code
docker logs cc-ollama-tunnel                 # Tunnel URL
```

## How it works

```
User (LINE app)
  ↕  LINE Messaging API webhook
cc-line-ollama (Bun HTTP server, port 3000)
  ↕  spawn("claude", ["-p", prompt, "--model", "qwen3:8b", ...])
Claude Code CLI
  ↕  ANTHROPIC_BASE_URL=http://localhost:11435 (proxy)
Ollama Proxy (port 11435, strips ?beta=true)
  ↕
Ollama (host, port 11434)
```

## Forked from

[claude-code-line](https://github.com/monthop-gmail/claude-code-line) — แยก Ollama mode ออกมาเป็น repo เฉพาะ
