// --- Session Manager ---

export interface MessagePart {
  id: string
  type: "text" | "tool_use" | "tool_result"
  text?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: string
  status?: "pending" | "running" | "completed" | "error"
}

export interface MessageInfo {
  id: string
  role: "user" | "assistant"
  parts: MessagePart[]
  createdAt: string
}

export interface SessionInfo {
  id: string
  claudeSessionId: string | null
  directory: string
  totalCost: number
  status: "idle" | "running"
  messages: MessageInfo[]
  createdAt: string
  updatedAt: string
}

const sessions = new Map<string, SessionInfo>()
const activeAborts = new Map<string, AbortController>()

let counter = 0

export function createSession(directory?: string): SessionInfo {
  const id = `s-${Date.now()}-${++counter}`
  const now = new Date().toISOString()
  const session: SessionInfo = {
    id,
    claudeSessionId: null,
    directory: directory ?? process.env.WORKSPACE_DIR ?? "/workspace",
    totalCost: 0,
    status: "idle",
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
  sessions.set(id, session)
  return session
}

export function getSession(id: string): SessionInfo | undefined {
  return sessions.get(id)
}

export function listSessions(): SessionInfo[] {
  return Array.from(sessions.values())
}

export function deleteSession(id: string): boolean {
  const session = sessions.get(id)
  if (!session) return false
  abortSession(id)
  sessions.delete(id)
  return true
}

export function updateSession(id: string, update: Partial<SessionInfo>): void {
  const session = sessions.get(id)
  if (session) {
    Object.assign(session, update)
    session.updatedAt = new Date().toISOString()
  }
}

export function addMessage(id: string, message: MessageInfo): void {
  const session = sessions.get(id)
  if (session) {
    session.messages.push(message)
    session.updatedAt = new Date().toISOString()
  }
}

export function setActiveAbort(id: string, controller: AbortController): void {
  activeAborts.set(id, controller)
}

export function clearActiveAbort(id: string): void {
  activeAborts.delete(id)
}

export function abortSession(id: string): boolean {
  const controller = activeAborts.get(id)
  if (controller) {
    controller.abort()
    activeAborts.delete(id)
    const session = sessions.get(id)
    if (session) session.status = "idle"
    return true
  }
  return false
}
