import { messagingApi } from "@line/bot-sdk"
import { createHmac } from "node:crypto"

// --- Config ---
const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN
const channelSecret = process.env.LINE_CHANNEL_SECRET
const port = Number(process.env.PORT ?? 3000)
const ollamaUrl = process.env.OLLAMA_URL ?? "http://host.docker.internal:11434"
const claudeModel = process.env.CLAUDE_MODEL ?? "qwen3:8b"
const claudeMaxTurns = process.env.CLAUDE_MAX_TURNS ?? "10"
const claudeMaxBudget = process.env.CLAUDE_MAX_BUDGET_USD ?? "1.00"
const claudeTimeoutMs = Number(process.env.CLAUDE_TIMEOUT_MS ?? 300_000)
const workspaceDir = process.env.WORKSPACE_DIR ?? "/workspace"

if (!channelAccessToken || !channelSecret) {
  console.error("Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET")
  process.exit(1)
}

console.log("CC Ollama LINE bot configuration:")
console.log("- Channel access token present:", !!channelAccessToken)
console.log("- Channel secret present:", !!channelSecret)
console.log("- Ollama URL:", ollamaUrl)
console.log("- Model:", claudeModel)
console.log("- Max turns:", claudeMaxTurns)
console.log("- Max budget:", `$${claudeMaxBudget}`)
console.log("- Timeout:", `${claudeTimeoutMs}ms`)
console.log("- Workspace:", workspaceDir)

// --- Ollama Proxy (strip ?beta=true that Claude Code adds) ---
const proxyPort = 11435

Bun.serve({
  port: proxyPort,
  async fetch(req) {
    const url = new URL(req.url)
    const pathname = url.pathname

    // Fake count_tokens endpoint (Ollama doesn't support it)
    if (pathname.endsWith("/count_tokens")) {
      const body = await req.json().catch(() => ({})) as any
      return Response.json({ input_tokens: body?.messages?.length ? 1000 : 0 })
    }

    // Strip query params (Claude Code adds ?beta=true which Ollama doesn't support)
    const targetUrl = `${ollamaUrl}${pathname}`
    const headers = new Headers()
    for (const [k, v] of req.headers.entries()) {
      if (k !== "host") headers.set(k, v)
    }
    const res = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      // @ts-ignore - Bun supports duplex
      duplex: "half",
    })
    const respHeaders = new Headers()
    for (const [k, v] of res.headers.entries()) {
      respHeaders.set(k, v)
    }
    return new Response(res.body, { status: res.status, headers: respHeaders })
  },
})
console.log(`Ollama proxy listening on http://localhost:${proxyPort} -> ${ollamaUrl}`)

// --- LINE Client ---
const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken })

// --- Session & Process Management ---
interface UserSession {
  sessionId: string | null
  totalCost: number
}

const sessions = new Map<string, UserSession>()
const activeProcesses = new Map<string, ReturnType<typeof Bun.spawn>>()
const userQueues = new Map<string, Promise<void>>()

// --- Claude Code subprocess runner ---
async function runClaude(
  userId: string,
  prompt: string,
  isRetry = false,
): Promise<{ result: string; sessionId: string; cost: number; isError: boolean }> {
  const session = sessions.get(userId)

  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-turns",
    claudeMaxTurns,
    "--max-budget-usd",
    claudeMaxBudget,
    "--dangerously-skip-permissions",
    "--model",
    claudeModel,
  ]

  if (session?.sessionId) {
    args.push("--resume", session.sessionId)
  }

  // Build clean environment — point Claude Code at Ollama via proxy
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  env.ANTHROPIC_AUTH_TOKEN = "ollama"
  env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}`
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDECODE

  console.log(
    `[${userId.slice(-8)}] Running claude ${session?.sessionId ? `--resume ${session.sessionId}` : "(new session)"}`,
  )

  const proc = Bun.spawn(["claude", ...args], {
    cwd: workspaceDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  activeProcesses.set(userId, proc)

  const timeoutId = setTimeout(() => {
    console.log(`[${userId.slice(-8)}] Timeout, killing process`)
    proc.kill()
  }, claudeTimeoutMs)

  try {
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    clearTimeout(timeoutId)
    activeProcesses.delete(userId)

    if (stderr) {
      console.error(`[${userId.slice(-8)}] stderr:`, stderr.slice(0, 500))
    }

    // Parse JSON output
    let parsed: any
    try {
      parsed = JSON.parse(stdout)
    } catch {
      // If resume failed, retry without --resume (once)
      if (
        !isRetry &&
        session?.sessionId &&
        (stdout.includes("No conversation found") ||
          stdout.includes("not found"))
      ) {
        console.log(
          `[${userId.slice(-8)}] Session expired, starting fresh`,
        )
        sessions.delete(userId)
        return runClaude(userId, prompt, true)
      }
      return {
        result: stdout || stderr || "Claude process returned no output",
        sessionId: session?.sessionId ?? "",
        cost: 0,
        isError: true,
      }
    }

    const newSessionId = parsed.session_id ?? session?.sessionId ?? ""
    const cost = parsed.total_cost_usd ?? 0

    sessions.set(userId, {
      sessionId: newSessionId,
      totalCost: (session?.totalCost ?? 0) + cost,
    })

    return {
      result: parsed.result ?? "Done. (no text output)",
      sessionId: newSessionId,
      cost,
      isError: parsed.is_error ?? false,
    }
  } catch (err: any) {
    clearTimeout(timeoutId)
    activeProcesses.delete(userId)
    throw err
  }
}

// --- Per-user request queue ---
function enqueueForUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userQueues.get(userId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  userQueues.set(
    userId,
    next.then(
      () => {},
      () => {},
    ),
  )
  return next
}

// --- LINE Signature Validation ---
function validateSignature(body: string, signature: string): boolean {
  const hash = createHmac("SHA256", channelSecret!)
    .update(body)
    .digest("base64")
  return hash === signature
}

// --- Chunk long messages for LINE (max 5000 chars) ---
const LINE_MAX_TEXT = 5000

function chunkText(text: string, limit: number = LINE_MAX_TEXT): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    let breakAt = remaining.lastIndexOf("\n", limit)
    if (breakAt < limit * 0.3) {
      breakAt = remaining.lastIndexOf(" ", limit)
    }
    if (breakAt < limit * 0.3) {
      breakAt = limit
    }

    const chunk = remaining.slice(0, breakAt)
    remaining = remaining.slice(breakAt).trimStart()

    // Handle unclosed code blocks
    const backtickCount = (chunk.match(/```/g) || []).length
    if (backtickCount % 2 !== 0) {
      chunks.push(chunk + "\n```")
      remaining = "```\n" + remaining
    } else {
      chunks.push(chunk)
    }
  }

  return chunks
}

// --- Send long message via Push API ---
async function sendMessage(userId: string, text: string): Promise<void> {
  const chunks = chunkText(text)
  for (const chunk of chunks) {
    await lineClient
      .pushMessage({
        to: userId,
        messages: [{ type: "text", text: chunk }],
      })
      .catch((err: any) => {
        console.error("Failed to send LINE message:", err?.message ?? err)
      })
  }
}

// --- Handle incoming LINE message ---
async function handleTextMessage(
  userId: string,
  text: string,
  replyToken: string,
): Promise<void> {
  console.log(`Message from ${userId}: ${text}`)

  // --- Commands ---
  if (text.toLowerCase() === "/new") {
    sessions.delete(userId)
    await lineClient.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: "เริ่ม session ใหม่แล้วครับ ส่งข้อความมาได้เลย!",
        },
      ],
    })
    return
  }

  if (text.toLowerCase() === "/abort") {
    const proc = activeProcesses.get(userId)
    if (proc) {
      proc.kill()
      activeProcesses.delete(userId)
      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: "text", text: "ยกเลิกคำสั่งแล้วครับ" }],
      })
    } else {
      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: "text", text: "ไม่มี session ที่ใช้งานอยู่ครับ" }],
      })
    }
    return
  }

  if (text.toLowerCase() === "/sessions") {
    const session = sessions.get(userId)
    const isRunning = activeProcesses.has(userId)
    const msg = session?.sessionId
      ? `Session: ...${session.sessionId.slice(-8)}\nStatus: ${isRunning ? "กำลังทำงาน" : "ว่าง"}`
      : "ยังไม่มี session ครับ ส่งข้อความมาเพื่อเริ่มใช้งาน!"
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: "text", text: msg }],
    })
    return
  }

  if (text.toLowerCase() === "/about" || text.toLowerCase() === "/who") {
    const aboutMsg = `🧑‍💻 สวัสดีครับ! ผมคือ CC Ollama Bot

🤖 Model: ${claudeModel} (local, ฟรี!)
📱 ทำงานผ่าน Claude Code CLI + Ollama
📦 GitHub: https://github.com/monthop-gmail/cc-line-ollama
📖 พิมพ์ /help ดูคำสั่งทั้งหมด`
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: "text", text: aboutMsg }],
    })
    return
  }

  if (text.toLowerCase() === "/help" || text.toLowerCase() === "/คำสั่ง") {
    const helpMsg = `📖 คำสั่งทั้งหมด:

🤖 ทั่วไป
  /about — แนะนำตัว bot
  /help — คำสั่งทั้งหมด

💻 Session
  /new — เริ่มบทสนทนาใหม่
  /abort — ยกเลิกคำสั่งที่กำลังทำ
  /sessions — ดูสถานะ session

💬 วิธีใช้งาน:
  พิมพ์ข้อความได้เลย! bot จะตอบผ่าน Claude Code CLI + Ollama`
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: "text", text: helpMsg }],
    })
    return
  }

  // --- Enqueue prompt ---
  enqueueForUser(userId, async () => {
    try {
      const { result, isError } = await runClaude(userId, text)

      let responseText = result
      if (isError) {
        responseText = `Error: ${result}`
      }

      console.log(
        `[${userId.slice(-8)}] Response: ${responseText.length} chars`,
      )
      await sendMessage(userId, responseText)
    } catch (err: any) {
      console.error("Claude prompt error:", err?.message)
      await sendMessage(
        userId,
        `เกิดข้อผิดพลาดครับ: ${err?.message?.slice(0, 200) ?? "ไม่ทราบสาเหตุ"}`,
      )
    }
  })
}

// --- HTTP Server for LINE Webhook ---
Bun.serve({
  port,
  async fetch(req: Request) {
    const url = new URL(req.url)

    if (req.method === "GET" && url.pathname === "/") {
      return new Response("CC Ollama LINE Bot is running")
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      const body = await req.text()
      const signature = req.headers.get("x-line-signature") || ""

      if (!validateSignature(body, signature)) {
        console.error("Invalid LINE signature")
        return new Response("Invalid signature", { status: 403 })
      }

      let parsed: { events: any[] }
      try {
        parsed = JSON.parse(body)
      } catch {
        return new Response("Invalid JSON", { status: 400 })
      }

      for (const event of parsed.events) {
        if (
          event.type === "message" &&
          event.message?.type === "text" &&
          event.source?.userId
        ) {
          handleTextMessage(
            event.source.userId,
            event.message.text,
            event.replyToken,
          ).catch((err) => {
            console.error("Error handling message:", err)
          })
        }
      }

      return new Response("OK")
    }

    return new Response("Not Found", { status: 404 })
  },
})

console.log(
  `CC Ollama LINE bot listening on http://localhost:${port}/webhook`,
)
