import { messagingApi } from "@line/bot-sdk"
import { createHmac } from "node:crypto"

// --- Config ---
const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN
const channelSecret = process.env.LINE_CHANNEL_SECRET
const port = Number(process.env.PORT ?? 3000)
const serverUrl = process.env.SERVER_URL ?? "http://server:4096"
const serverPassword = process.env.SERVER_PASSWORD
const timeoutMs = Number(process.env.PROMPT_TIMEOUT_MS ?? 300_000)

if (!channelAccessToken || !channelSecret) {
  console.error("Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET")
  process.exit(1)
}

console.log("Claude Code LINE bot configuration:")
console.log("- Server URL:", serverUrl)
console.log("- Server auth:", serverPassword ? "enabled" : "disabled")
console.log("- Timeout:", `${timeoutMs}ms`)

// --- LINE Client ---
const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken })

// --- Server HTTP Client ---
const serverAuth = serverPassword ? `Bearer ${serverPassword}` : ""

async function serverRequest(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  const headers: Record<string, string> = {}
  if (serverAuth) headers["Authorization"] = serverAuth
  if (body !== undefined) headers["Content-Type"] = "application/json"

  const resp = await fetch(`${serverUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  })

  const text = await resp.text()
  if (!resp.ok) throw new Error(`Server ${resp.status}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// --- Session Management ---
interface UserSession {
  sessionId: string
  totalCost: number
}

const sessions = new Map<string, UserSession>()
const userQueues = new Map<string, Promise<void>>()

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

// --- Send prompt to server ---
async function sendPrompt(
  userId: string,
  prompt: string,
): Promise<{ result: string; cost: number; isError: boolean }> {
  const session = sessions.get(userId)

  // Create session if needed
  if (!session) {
    const created = await serverRequest("POST", "/session")
    sessions.set(userId, { sessionId: created.id, totalCost: 0 })
    console.log(`[${userId.slice(-8)}] Created session: ${created.id}`)
  }

  const { sessionId } = sessions.get(userId)!

  console.log(`[${userId.slice(-8)}] Sending prompt to session ${sessionId}`)

  try {
    const result = await serverRequest(
      "POST",
      `/session/${sessionId}/message`,
      { prompt },
    )

    const cost = result.cost_usd ?? 0
    const s = sessions.get(userId)!
    s.totalCost += cost

    return {
      result: result.result ?? "Done. (no text output)",
      cost,
      isError: result.is_error ?? false,
    }
  } catch (err: any) {
    // If session expired or not found, create fresh and retry
    if (
      err?.message?.includes("404") ||
      err?.message?.includes("not found") ||
      err?.message?.includes("No conversation")
    ) {
      console.log(`[${userId.slice(-8)}] Session expired, creating fresh`)
      sessions.delete(userId)
      return sendPrompt(userId, prompt)
    }
    throw err
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
    const session = sessions.get(userId)
    if (session) {
      await serverRequest("DELETE", `/session/${session.sessionId}`).catch(
        () => {},
      )
    }
    sessions.delete(userId)
    await lineClient.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: "Session cleared. Next message starts a new session.",
        },
      ],
    })
    return
  }

  if (text.toLowerCase() === "/abort") {
    const session = sessions.get(userId)
    if (session) {
      const res = await serverRequest(
        "POST",
        `/session/${session.sessionId}/abort`,
      ).catch(() => ({ aborted: false }))
      if (res.aborted) {
        await lineClient.replyMessage({
          replyToken,
          messages: [{ type: "text", text: "Prompt cancelled." }],
        })
        return
      }
    }
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "No active prompt." }],
    })
    return
  }

  if (text.toLowerCase() === "/sessions") {
    const session = sessions.get(userId)
    if (session) {
      const info = await serverRequest(
        "GET",
        `/session/${session.sessionId}`,
      ).catch(() => null)
      const msg = info
        ? `Session: ${session.sessionId}\nCost: $${session.totalCost.toFixed(4)}\nStatus: ${info.status}`
        : `Session: ${session.sessionId}\nCost: $${session.totalCost.toFixed(4)}`
      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: "text", text: msg }],
      })
    } else {
      await lineClient.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text: "No active session. Send a message to start one.",
          },
        ],
      })
    }
    return
  }

  if (text.toLowerCase() === "/cost") {
    const session = sessions.get(userId)
    const msg = session
      ? `Total cost this session: $${session.totalCost.toFixed(4)}`
      : "No active session."
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: "text", text: msg }],
    })
    return
  }

  // --- Enqueue prompt ---
  enqueueForUser(userId, async () => {
    try {
      const { result, cost, isError } = await sendPrompt(userId, text)

      let responseText = result
      if (cost > 0) {
        responseText += `\n\n[cost: $${cost.toFixed(4)}]`
      }
      if (isError) {
        responseText = `Error: ${result}`
      }

      console.log(
        `[${userId.slice(-8)}] Response: ${responseText.length} chars, cost: $${cost.toFixed(4)}`,
      )
      await sendMessage(userId, responseText)
    } catch (err: any) {
      console.error("Prompt error:", err?.message)
      await sendMessage(
        userId,
        `Error: ${err?.message?.slice(0, 200) ?? "Unknown error"}`,
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
      return new Response("Claude Code LINE Bot is running")
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
  `Claude Code LINE bot listening on http://localhost:${port}/webhook`,
)
