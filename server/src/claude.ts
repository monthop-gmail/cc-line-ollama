// --- Claude Agent SDK integration ---

import { query } from "@anthropic-ai/claude-agent-sdk"
import { publish } from "./events"
import type { MessageInfo, MessagePart } from "./session"

export interface ClaudeOptions {
  model?: string
  maxTurns?: number
  maxBudget?: number
  systemPrompt?: string
  resumeSessionId?: string
  workspaceDir?: string
  abortController?: AbortController
  /** Our internal session ID for publishing SSE events */
  sessionId?: string
}

export interface ClaudeResult {
  result: string
  session_id: string
  cost_usd: number
  duration_ms: number
  is_error: boolean
  messages: MessageInfo[]
}

const defaultModel = process.env.CLAUDE_MODEL ?? "sonnet"
const defaultMaxTurns = Number(process.env.CLAUDE_MAX_TURNS ?? 10)
const defaultMaxBudget = Number(process.env.CLAUDE_MAX_BUDGET_USD ?? 1.00)
const defaultWorkspaceDir = process.env.WORKSPACE_DIR ?? "/workspace"

export async function runClaude(
  prompt: string,
  options: ClaudeOptions = {},
  isRetry = false,
): Promise<ClaudeResult> {
  const start = Date.now()
  const cwd = options.workspaceDir ?? defaultWorkspaceDir
  const abortController = options.abortController ?? new AbortController()
  const sid = options.sessionId // our session ID for events

  const collectedMessages: MessageInfo[] = []
  let sdkSessionId = ""
  let resultText = ""
  let costUsd = 0
  let isError = false

  try {
    const q = query({
      prompt,
      options: {
        cwd,
        model: options.model ?? defaultModel,
        maxTurns: options.maxTurns ?? defaultMaxTurns,
        maxBudgetUsd: options.maxBudget ?? defaultMaxBudget,
        systemPrompt: options.systemPrompt,
        resume: options.resumeSessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        abortController,
      },
    })

    for await (const msg of q) {
      switch (msg.type) {
        case "system": {
          if ("session_id" in msg && msg.session_id) {
            sdkSessionId = msg.session_id as string
          }
          break
        }

        case "assistant": {
          const m = msg as any
          sdkSessionId = m.session_id || sdkSessionId
          const parts: MessagePart[] = []

          const content = m.message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                parts.push({
                  id: crypto.randomUUID(),
                  type: "text",
                  text: block.text,
                })
              } else if (block.type === "tool_use") {
                parts.push({
                  id: block.id,
                  type: "tool_use",
                  toolName: block.name,
                  toolInput: block.input,
                  status: "running",
                })
              }
            }
          }

          const assistantMsg: MessageInfo = {
            id: m.uuid || crypto.randomUUID(),
            role: "assistant",
            parts,
            createdAt: new Date().toISOString(),
          }
          collectedMessages.push(assistantMsg)

          if (sid) {
            publish({
              type: "message.updated",
              properties: { sessionId: sid, message: assistantMsg },
            })
            for (const part of parts) {
              publish({
                type: "message.part.updated",
                properties: { sessionId: sid, messageId: assistantMsg.id, part },
              })
            }
          }
          break
        }

        case "user": {
          const m = msg as any
          const content = m.message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result" && sid) {
                publish({
                  type: "message.part.updated",
                  properties: {
                    sessionId: sid,
                    messageId: block.tool_use_id || "",
                    part: {
                      id: block.tool_use_id,
                      type: "tool_result",
                      toolResult:
                        typeof block.content === "string"
                          ? block.content
                          : JSON.stringify(block.content),
                      status: "completed",
                    },
                  },
                })
              }
            }
          }
          break
        }

        case "stream_event": {
          const m = msg as any
          const event = m.event
          if (
            event?.type === "content_block_delta" &&
            event?.delta?.type === "text_delta" &&
            sid
          ) {
            publish({
              type: "message.part.delta",
              properties: {
                sessionId: sid,
                messageId: m.uuid || "",
                delta: event.delta.text,
              },
            })
          }
          break
        }

        case "result": {
          const m = msg as any
          sdkSessionId = m.session_id || sdkSessionId
          costUsd = m.total_cost_usd ?? 0
          isError = m.is_error ?? false

          if (m.subtype === "success") {
            resultText = m.result ?? ""
          } else {
            resultText = m.result ?? m.error ?? "Error during execution"
            isError = true
          }
          break
        }
      }
    }
  } catch (err: any) {
    // If resume failed, retry without resume once
    if (
      !isRetry &&
      options.resumeSessionId &&
      (err?.message?.includes("not found") ||
        err?.message?.includes("No conversation"))
    ) {
      console.log(`[claude] Session expired, retrying without resume`)
      return runClaude(
        prompt,
        { ...options, resumeSessionId: undefined },
        true,
      )
    }

    if (err?.name === "AbortError") {
      resultText = "Query was aborted"
    } else {
      resultText = err?.message ?? "Unknown error"
    }
    isError = true
  }

  return {
    result: resultText || "Done. (no text output)",
    session_id: sdkSessionId,
    cost_usd: costUsd,
    duration_ms: Date.now() - start,
    is_error: isError,
    messages: collectedMessages,
  }
}
