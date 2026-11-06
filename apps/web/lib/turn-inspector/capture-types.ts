export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export type ObservedValue = { available: false } | { available: true; value: JsonValue }
export interface PublicTurn {
  id: string
  status: "submitting" | "running" | "waiting_for_user" | "stopping" | "reconciling" | "terminal"
  submission: "prepared" | "acknowledged" | "unknown"
  outcome: "completed" | "cancelled" | "failed" | null
}
export interface PublicItem {
  id: string
  turnId: string
  role: "user" | "assistant" | "tool" | "system"
  type: string
  name: string
  state: "streaming" | "complete" | "unknown"
  content: ObservedValue
  input: ObservedValue
  result: ObservedValue
  provenance: "live" | "snapshot" | "cache"
  toolCallId?: string
  parentId?: string
}
export interface PublicRequest {
  id: string
  turnId: string
  kind:
    | "command_approval"
    | "file_change_approval"
    | "tool_permission"
    | "user_question"
    | "elicitation"
    | "unknown"
  state: "pending" | "resolved" | "expired"
  prompt: ObservedValue
  decision: ObservedValue
}
export type Notice = { code: string; text: string }
export interface ReplayState {
  turns: PublicTurn[]
  items: PublicItem[]
  requests: PublicRequest[]
  notices: Notice[]
}
export type Change =
  | { kind: "turn"; turn: PublicTurn }
  | { kind: "item"; item: PublicItem }
  | { kind: "delta"; itemId: string; text: string }
  | { kind: "request"; request: PublicRequest }
  | ({ kind: "notice" } & Notice)
export interface CaptureEvent {
  sequence: number
  elapsedMs: number
  sourceSequence: number
  changes: Change[]
}
export interface Capture {
  version: 1
  id: string
  provenance: "live" | "synthetic"
  recordedAt: string
  revisions: { app: string; runtime: string; example: string }
  initial: ReplayState
  events: CaptureEvent[]
  moments: { id: string; eventIndex: number; label: string; itemId?: string }[]
}
