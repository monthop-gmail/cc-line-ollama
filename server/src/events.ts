// --- Simple Event Bus for SSE broadcasting ---

import type { MessageInfo, MessagePart, SessionInfo } from "./session"

export type ServerEvent =
  | { type: "server.connected"; properties: Record<string, never> }
  | { type: "server.heartbeat"; properties: Record<string, never> }
  | { type: "session.created"; properties: { session: SessionInfo } }
  | { type: "session.updated"; properties: { session: SessionInfo } }
  | { type: "session.deleted"; properties: { sessionId: string } }
  | { type: "message.updated"; properties: { sessionId: string; message: MessageInfo } }
  | {
      type: "message.part.updated"
      properties: { sessionId: string; messageId: string; part: MessagePart }
    }
  | {
      type: "message.part.delta"
      properties: { sessionId: string; messageId: string; delta: string }
    }

type Subscriber = (event: ServerEvent) => void

const subscribers = new Set<Subscriber>()

export function publish(event: ServerEvent): void {
  for (const sub of subscribers) {
    try {
      sub(event)
    } catch {
      // Ignore subscriber errors (e.g. closed SSE connection)
    }
  }
}

export function subscribe(callback: Subscriber): () => void {
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
  }
}
