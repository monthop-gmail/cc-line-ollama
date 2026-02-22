# cc-line-ollama

LINE Messaging API bridge for Claude Code with Ollama (local LLM). Chat with a local AI coding agent through LINE — no API key needed.

## Architecture

```
LINE → Cloudflare Tunnel → line-bot (Bun) → server (Claude Agent SDK) → Ollama (Docker) → qwen3:8b
```

4 containers:
- **ollama** — Local LLM inference engine (Docker)
- **server** — Claude Code API server (Hono + Claude Agent SDK)
- **line-bot** — LINE webhook handler (Bun + @line/bot-sdk)
- **cloudflared** — Cloudflare tunnel to expose webhook

The bot can work with any compatible server by changing `SERVER_URL`.

## Setup

1. Create a LINE Messaging API channel at https://developers.line.biz/console/
2. In the channel settings:
   - Enable "Use webhook"
   - Issue a "Channel access token (long-lived)"
   - Note the "Channel secret"
3. Copy and edit `.env`:

```bash
cp .env.example .env
# Edit .env with your credentials (no Anthropic API key needed)
```

## Usage

```bash
# Start all containers
docker compose up -d --build

# Pull model (required on first run)
docker exec cc-ollama-engine ollama pull qwen3:8b

# Get the tunnel URL
docker logs cc-ollama-tunnel 2>&1 | grep -o 'https://[^ ]*'
```

Set the webhook URL in LINE Developer Console: `https://<tunnel-url>/webhook`

Check server health:
```bash
docker exec cc-ollama-line-bot curl -s http://server:4096/health
```

## Model Switching

```bash
# Pull a different model
docker exec cc-ollama-engine ollama pull llama3.1:8b

# Update .env
CLAUDE_MODEL=llama3.1:8b

# Restart server
docker compose up -d server
```

Popular models for coding:
- `qwen3:8b` (default) — good balance of speed and quality
- `llama3.1:8b` — Meta's general-purpose model
- `deepseek-coder-v2:16b` — specialized for code
- `codellama:13b` — Meta's code-specific model

## GPU Support

Uncomment the GPU section in `docker-compose.yml` for NVIDIA GPU acceleration:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

Requires [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/).

## Commands

- Send any text message to start coding
- `/new` - Start a new coding session
- `/abort` - Cancel the current prompt
- `/sessions` - Show active session info
- `/cost` - Show total cost for current session

## How it works

Each LINE user gets their own Claude Code session. Messages are forwarded to the server API via HTTP, which runs Claude Code Agent SDK pointing at the Ollama container.

```
User (LINE app)
  ↕  LINE Messaging API webhook
line-bot (Bun, port 3000)
  ↕  HTTP fetch → http://server:4096
server (Hono + Claude Agent SDK, port 4096)
  ↕  query() → Claude Code CLI (bundled in SDK)
  ↕  ANTHROPIC_BASE_URL → http://ollama:11434
ollama (port 11434) → qwen3:8b
```

## Environment Variables

### Bot
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | - | LINE channel access token |
| `LINE_CHANNEL_SECRET` | Yes | - | LINE channel secret |
| `SERVER_URL` | No | `http://server:4096` | Server API URL |
| `SERVER_PASSWORD` | No | - | Server auth password |
| `PROMPT_TIMEOUT_MS` | No | `300000` | Timeout per prompt (5 min) |

### Server
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_PASSWORD` | No | - | API auth password |
| `CLAUDE_MODEL` | No | `qwen3:8b` | Ollama model to use |
| `CLAUDE_MAX_TURNS` | No | `10` | Max agentic turns per prompt |
| `CLAUDE_MAX_BUDGET_USD` | No | `1.00` | Max spend per prompt |

### Docker
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLOUDFLARE_TUNNEL_TOKEN` | Yes | - | Cloudflare tunnel token |
| `PROJECT_DIR` | No | `./workspace` | Project directory to mount |

## Docker Commands

```bash
# Logs
docker logs cc-ollama-engine --tail 30       # Ollama
docker logs cc-ollama-server --tail 30       # Server
docker logs cc-ollama-line-bot --tail 30     # Bot
docker logs cc-ollama-tunnel                 # Tunnel

# List models
docker exec cc-ollama-engine ollama list

# Stop
docker compose down
```
