import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { runClaude } from "./claude"
import { publish, subscribe } from "./events"
import {
  addMessage,
  clearActiveAbort,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  setActiveAbort,
  updateSession,
  abortSession,
} from "./session"

const port = Number(process.env.PORT ?? 4096)
const apiPassword = process.env.API_PASSWORD
const defaultModel = process.env.CLAUDE_MODEL ?? "sonnet"

type Env = { Variables: { directory: string } }
const app = new Hono<Env>()

// --- Middleware ---
app.use("*", cors())

// Optional auth
if (apiPassword) {
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/" || c.req.path === "/event") {
      return next()
    }

    const auth = c.req.header("Authorization")
    if (!auth) {
      return c.json({ error: "Authorization required" }, 401)
    }

    if (auth.startsWith("Bearer ")) {
      if (auth.slice(7) !== apiPassword) {
        return c.json({ error: "Invalid password" }, 403)
      }
    } else if (auth.startsWith("Basic ")) {
      const decoded = atob(auth.slice(6))
      const password = decoded.includes(":") ? decoded.split(":")[1] : decoded
      if (password !== apiPassword) {
        return c.json({ error: "Invalid password" }, 403)
      }
    } else {
      return c.json({ error: "Invalid auth format" }, 401)
    }

    return next()
  })
}

// Directory middleware: x-opencode-directory header or ?directory= query param
app.use("*", async (c, next) => {
  const directory =
    c.req.query("directory") ||
    c.req.header("x-opencode-directory") ||
    process.env.WORKSPACE_DIR ||
    "/workspace"
  c.set("directory", directory)
  return next()
})

// --- Routes: Info ---

app.get("/", (c) => {
  return c.json({
    name: "claude-code-server",
    description: "Claude Code REST API Server (Agent SDK)",
    version: "2.0.0",
    endpoints: [
      "GET  /event — SSE event stream",
      "POST /query — Send a prompt (stateless)",
      "GET  /models — List available models",
      "GET  /health — Health check",
      "POST /session — Create a session",
      "GET  /session — List sessions",
      "GET  /session/:id — Get session details",
      "GET  /session/:id/message — Get session messages",
      "POST /session/:id/message — Send prompt in session",
      "POST /session/:id/abort — Abort active prompt",
      "DELETE /session/:id — Delete session",
    ],
  })
})

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() })
})

app.get("/models", (c) => {
  return c.json({
    default: defaultModel,
    models: [
      { id: "sonnet", name: "Claude Sonnet", description: "Balanced — good for most tasks" },
      { id: "opus", name: "Claude Opus", description: "Strongest — best quality" },
      { id: "haiku", name: "Claude Haiku", description: "Fast — cheapest" },
    ],
  })
})

// --- Routes: SSE Event Stream ---

app.get("/event", (c) => {
  return streamSSE(c, async (stream) => {
    console.log("[sse] client connected")

    await stream.writeSSE({
      data: JSON.stringify({ type: "server.connected", properties: {} }),
    })

    const unsub = subscribe((event) => {
      stream.writeSSE({ data: JSON.stringify(event) })
    })

    const heartbeat = setInterval(() => {
      stream.writeSSE({
        data: JSON.stringify({ type: "server.heartbeat", properties: {} }),
      })
    }, 30_000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat)
        unsub()
        console.log("[sse] client disconnected")
        resolve()
      })
    })
  })
})

// --- Routes: Stateless Query ---

app.post("/query", async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.prompt) {
    return c.json({ error: "Missing 'prompt' in request body" }, 400)
  }

  const { prompt, model, system_prompt, max_turns, max_budget } = body
  const directory = c.get("directory")

  console.log(`[query] prompt: ${prompt.slice(0, 100)}...`)

  const result = await runClaude(prompt, {
    model,
    systemPrompt: system_prompt,
    maxTurns: max_turns,
    maxBudget: max_budget,
    workspaceDir: directory,
  })

  console.log(`[query] done: ${result.duration_ms}ms, cost: $${result.cost_usd.toFixed(4)}`)

  return c.json({
    result: result.result,
    model: model ?? defaultModel,
    session_id: result.session_id,
    cost_usd: result.cost_usd,
    duration_ms: result.duration_ms,
    is_error: result.is_error,
  })
})

// --- Routes: Session Management ---

app.post("/session", async (c) => {
  const directory = c.get("directory")
  const body = await c.req.json().catch(() => ({}))
  const session = createSession(body?.directory || directory)
  console.log(`[session] created: ${session.id} (dir: ${session.directory})`)
  publish({ type: "session.created", properties: { session } })
  return c.json(session)
})

app.get("/session", (c) => {
  return c.json({ sessions: listSessions() })
})

app.get("/session/:id", (c) => {
  const { id } = c.req.param()
  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }
  return c.json(session)
})

app.get("/session/:id/message", (c) => {
  const { id } = c.req.param()
  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }
  return c.json({ messages: session.messages })
})

app.post("/session/:id/message", async (c) => {
  const { id } = c.req.param()
  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  const body = await c.req.json().catch(() => null)
  if (!body?.prompt) {
    return c.json({ error: "Missing 'prompt' in request body" }, 400)
  }

  if (session.status === "running") {
    return c.json({ error: "Session is busy — use /session/:id/abort to cancel" }, 409)
  }

  const { prompt, model, system_prompt, max_turns, max_budget } = body
  const abortController = new AbortController()

  updateSession(id, { status: "running" })
  setActiveAbort(id, abortController)
  publish({ type: "session.updated", properties: { session: getSession(id)! } })

  console.log(`[session:${id}] prompt: ${prompt.slice(0, 100)}...`)

  const result = await runClaude(prompt, {
    model,
    systemPrompt: system_prompt,
    maxTurns: max_turns,
    maxBudget: max_budget,
    resumeSessionId: session.claudeSessionId ?? undefined,
    workspaceDir: session.directory,
    abortController,
    sessionId: id,
  })

  // Update session state
  updateSession(id, {
    status: "idle",
    claudeSessionId: result.session_id || session.claudeSessionId,
    totalCost: session.totalCost + result.cost_usd,
  })
  for (const msg of result.messages) {
    addMessage(id, msg)
  }
  clearActiveAbort(id)
  publish({ type: "session.updated", properties: { session: getSession(id)! } })

  console.log(`[session:${id}] done: ${result.duration_ms}ms, cost: $${result.cost_usd.toFixed(4)}`)

  return c.json({
    result: result.result,
    model: model ?? defaultModel,
    session_id: result.session_id,
    cost_usd: result.cost_usd,
    total_cost_usd: session.totalCost + result.cost_usd,
    duration_ms: result.duration_ms,
    is_error: result.is_error,
  })
})

app.post("/session/:id/abort", (c) => {
  const { id } = c.req.param()
  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  const aborted = abortSession(id)
  if (aborted) {
    publish({ type: "session.updated", properties: { session: getSession(id)! } })
  }
  return c.json({ aborted })
})

app.delete("/session/:id", (c) => {
  const { id } = c.req.param()
  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }
  deleteSession(id)
  publish({ type: "session.deleted", properties: { sessionId: id } })
  return c.json({ deleted: true })
})

// --- Start Server ---

console.log("Claude Code Server v2.0 (Agent SDK)")
console.log("- Port:", port)
console.log("- Default model:", defaultModel)
console.log("- Auth:", apiPassword ? "enabled" : "disabled")
console.log("- Workspace:", process.env.WORKSPACE_DIR ?? "/workspace")

export default {
  port,
  fetch: app.fetch,
}
