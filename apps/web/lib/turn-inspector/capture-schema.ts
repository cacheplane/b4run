import type { Capture, Change, ReplayState } from "./capture-types"
import { applyChange } from "./replay"

export const CAPTURE_MAX_BYTES = 20 * 1024 * 1024
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
function assert(ok: unknown, path: string): asserts ok {
  if (!ok) throw new Error(`Invalid capture: ${path}`)
}
function record(value: unknown, path: string): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), path)
}
function string(value: unknown, path: string): asserts value is string {
  assert(typeof value === "string", path)
}
function id(value: unknown, path: string) {
  string(value, path)
  assert(slug.test(value), path)
}
function choice(value: unknown, choices: string[], path: string) {
  assert(typeof value === "string" && choices.includes(value), path)
}
function list(value: unknown, path: string): asserts value is unknown[] {
  assert(Array.isArray(value), path)
}
function observed(value: unknown, path: string) {
  record(value, path)
  assert(typeof value.available === "boolean", `${path}.available`)
  assert(
    value.available ? Object.hasOwn(value, "value") : !Object.hasOwn(value, "value"),
    `${path}.value`,
  )
}
function bounds(value: unknown, depth = 0): void {
  assert(depth <= 32, "nesting depth limit exceeded")
  if (typeof value === "string")
    assert(new TextEncoder().encode(value).length <= 1024 * 1024, "string limit exceeded")
  if (typeof value === "number") assert(Number.isFinite(value), "nonfinite number")
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assert(!["__proto__", "constructor", "prototype"].includes(key), "unsafe object key")
      bounds(key, depth + 1)
      bounds(child, depth + 1)
    }
  }
}
function turn(value: unknown) {
  record(value, "turn")
  id(value.id, "turn.id")
  choice(
    value.status,
    ["submitting", "running", "waiting_for_user", "stopping", "reconciling", "terminal"],
    "turn.status",
  )
  choice(value.submission, ["prepared", "acknowledged", "unknown"], "turn.submission")
  assert(
    value.outcome === null ||
      ["completed", "cancelled", "failed"].includes(value.outcome as string),
    "turn.outcome",
  )
  assert(value.outcome === null || value.status === "terminal", "nonterminal outcome")
}
function item(value: unknown) {
  record(value, "item")
  id(value.id, "item.id")
  id(value.turnId, "item.turnId")
  choice(value.role, ["user", "assistant", "tool", "system"], "item.role")
  string(value.type, "item.type")
  string(value.name, "item.name")
  choice(value.state, ["streaming", "complete", "unknown"], "item.state")
  choice(value.provenance, ["live", "snapshot", "cache"], "item.provenance")
  for (const key of ["content", "input", "result"]) observed(value[key], `item.${key}`)
  for (const key of ["toolCallId", "parentId"])
    if (value[key] !== undefined) id(value[key], `item.${key}`)
}
function request(value: unknown) {
  record(value, "request")
  id(value.id, "request.id")
  id(value.turnId, "request.turnId")
  choice(
    value.kind,
    [
      "command_approval",
      "file_change_approval",
      "tool_permission",
      "user_question",
      "elicitation",
      "unknown",
    ],
    "request.kind",
  )
  choice(value.state, ["pending", "resolved", "expired"], "request.state")
  observed(value.prompt, "request.prompt")
  observed(value.decision, "request.decision")
  assert(
    value.state === "resolved" || !(value.decision as { available: boolean }).available,
    "decision before resolution",
  )
}
function change(value: unknown): asserts value is Change {
  record(value, "change")
  switch (value.kind) {
    case "turn":
      turn(value.turn)
      break
    case "item":
      item(value.item)
      break
    case "request":
      request(value.request)
      break
    case "delta":
      id(value.itemId, "delta.itemId")
      string(value.text, "delta.text")
      break
    case "notice":
      id(value.code, "notice.code")
      string(value.text, "notice.text")
      break
    default:
      throw new Error("Invalid capture: change.kind")
  }
}
function checkedApply(state: ReplayState, change: Change): ReplayState {
  if (change.kind === "turn") {
    const old = state.turns.find((t) => t.id === change.turn.id)
    assert(
      !old ||
        old.status !== "terminal" ||
        (change.turn.status === "terminal" && old.outcome === change.turn.outcome),
      "terminal turn reversal",
    )
    assert(
      !old || old.submission !== "acknowledged" || change.turn.submission === "acknowledged",
      "submission reversal",
    )
  }
  if (change.kind === "item" || change.kind === "request") {
    const value = change.kind === "item" ? change.item : change.request
    const old = (change.kind === "item" ? state.items : state.requests).find(
      (x) => x.id === value.id,
    )
    assert(!old || old.turnId === value.turnId, "changed turn identity")
  }
  if (change.kind === "item") {
    const old = state.items.find((x) => x.id === change.item.id)
    assert(
      !old || old.state !== "complete" || change.item.state === "complete",
      "item state reversal",
    )
    assert(
      !change.item.parentId || state.items.some((x) => x.id === change.item.parentId),
      "missing parent item",
    )
  }
  if (change.kind === "request") {
    const old = state.requests.find((x) => x.id === change.request.id)
    assert(
      !old || old.state === "pending" || change.request.state === old.state,
      "request state reversal",
    )
    assert(!old || old.kind === change.request.kind, "changed request kind")
  }
  if (change.kind === "delta") {
    const old = state.items.find((x) => x.id === change.itemId)
    assert(old && old.state === "streaming", "delta requires a streaming item")
    assert(
      !old.content.available || typeof old.content.value === "string",
      "delta requires text content",
    )
    assert(
      new TextEncoder().encode(`${old.content.available ? old.content.value : ""}${change.text}`)
        .length <=
        1024 * 1024,
      "assembled string limit exceeded",
    )
  }
  return applyChange(state, change)
}
export function parseCapture(text: string): Capture {
  assert(new TextEncoder().encode(text).length <= CAPTURE_MAX_BYTES, "byte limit exceeded")
  const raw: unknown = JSON.parse(text)
  bounds(raw)
  record(raw, "root")
  assert(raw.version === 1, "unsupported version")
  id(raw.id, "id")
  choice(raw.provenance, ["live", "synthetic"], "provenance")
  string(raw.recordedAt, "recordedAt")
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(raw.recordedAt) &&
      Number.isFinite(Date.parse(raw.recordedAt)),
    "recordedAt",
  )
  record(raw.revisions, "revisions")
  for (const key of ["app", "runtime", "example"])
    assert(
      typeof raw.revisions[key] === "string" && /^[a-f0-9]{40}$/.test(raw.revisions[key]),
      `revisions.${key}`,
    )
  record(raw.initial, "initial")
  let state: ReplayState = { turns: [], items: [], requests: [], notices: [] }
  for (const [key, kind] of [
    ["turns", "turn"],
    ["items", "item"],
    ["requests", "request"],
    ["notices", "notice"],
  ] as const) {
    list(raw.initial[key], `initial.${key}`)
    const ids = new Set()
    for (const value of raw.initial[key]) {
      const c = kind === "notice" ? { ...(value as object), kind } : { kind, [kind]: value }
      change(c)
      if (kind !== "notice") {
        record(value, kind)
        assert(!ids.has(value.id), "duplicate initial ID")
        ids.add(value.id)
      }
      state = checkedApply(state, c)
    }
  }
  list(raw.events, "events")
  assert(raw.events.length <= 50_000, "event count limit exceeded")
  list(raw.moments, "moments")
  const moments = new Map<number, Record<string, unknown>[]>()
  const momentIds = new Set()
  for (const m of raw.moments) {
    record(m, "moment")
    id(m.id, "moment.id")
    string(m.label, "moment.label")
    assert(!momentIds.has(m.id), "duplicate moment")
    momentIds.add(m.id)
    assert(
      Number.isInteger(m.eventIndex) &&
        (m.eventIndex as number) >= 0 &&
        (m.eventIndex as number) < raw.events.length,
      "moment index",
    )
    if (m.itemId !== undefined) id(m.itemId, "moment.itemId")
    const index = m.eventIndex as number
    moments.set(index, [...(moments.get(index) ?? []), m])
  }
  let elapsed = 0,
    source = -1
  for (const [index, event] of raw.events.entries()) {
    record(event, "event")
    assert(event.sequence === index, "noncontiguous sequence")
    assert(typeof event.elapsedMs === "number" && event.elapsedMs >= elapsed, "elapsed time")
    assert(
      Number.isSafeInteger(event.sourceSequence) && (event.sourceSequence as number) > source,
      "source sequence",
    )
    elapsed = event.elapsedMs
    source = event.sourceSequence as number
    list(event.changes, "event.changes")
    for (const c of event.changes) {
      change(c)
      state = checkedApply(state, c)
    }
    for (const m of moments.get(index) ?? [])
      assert(
        m.itemId === undefined || state.items.some((x) => x.id === m.itemId),
        "moment item unavailable",
      )
  }
  // User messages can precede their first turn-state event. Check membership
  // over the complete recording without projecting the later state backward.
  for (const value of [...state.items, ...state.requests]) {
    assert(
      state.turns.some((t) => t.id === value.turnId),
      "missing turn reference",
    )
  }
  return raw as unknown as Capture
}
