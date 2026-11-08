import { CAPTURE_MAX_BYTES, parseCapture } from "../../apps/web/lib/turn-inspector/capture-schema"
import type { Capture } from "../../apps/web/lib/turn-inspector/capture-types"
import { stateAt } from "../../apps/web/lib/turn-inspector/replay"
import { assertSafeText, assertSafeValues } from "./sanitize"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid private recording object")
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Invalid private recording identifier")
  return value
}
const observed = (fields: Record<string, unknown>, key: string) =>
  Object.hasOwn(fields, key) ? { available: true, value: fields[key] } : { available: false }
export function normalizeRecording(
  input: string,
  meta: Pick<Capture, "id" | "provenance" | "revisions">,
): Capture {
  if (new TextEncoder().encode(input).length > CAPTURE_MAX_BYTES)
    throw new Error("Private recording byte limit exceeded")
  const raw = object(JSON.parse(input))
  if (
    raw.format !== "b4app-docs-private-v1" ||
    raw.complete !== true ||
    !Array.isArray(raw.events) ||
    raw.events.length > 50_000
  )
    throw new Error("A complete supported private recording is required")
  const aliases = new Map<string, Map<string, string>>()
  const alias = (kind: string, value: unknown) => {
    const key = text(value)
    let ids = aliases.get(kind)
    if (!ids) {
      ids = new Map()
      aliases.set(kind, ids)
    }
    let id = ids.get(key)
    if (!id) {
      id = `${kind}-${ids.size + 1}`
      ids.set(key, id)
    }
    return id
  }
  const nativeItems = new Map<string, string>()
  const streamed = new Map<string, string>()
  const events = raw.events.map((value, sequence) => {
    const event = object(value),
      fields = object(event.fields)
    const turnId = alias("turn", event.turnId)
    let changes: unknown[]
    switch (event.kind) {
      case "turn.acknowledged":
      case "turn.state_changed":
      case "turn.finished":
        if (fields.id !== event.turnId) throw new Error("Turn mapping mismatch")
        changes = [
          {
            kind: "turn",
            turn: {
              id: turnId,
              status: fields.status,
              submission: fields.submission,
              outcome: fields.outcome,
            },
          },
        ]
        break
      case "message.started":
      case "message.completed":
      case "tool.started":
      case "tool.completed": {
        const id = alias("item", fields.id)
        if (fields.nativeItemId !== undefined) {
          const native = `${turnId}:${text(fields.nativeItemId)}`
          const previous = nativeItems.get(native)
          if (previous && previous !== id) throw new Error("Ambiguous native item mapping")
          nativeItems.set(native, id)
        }
        const complete = String(event.kind).endsWith(".completed")
        if (!complete && typeof fields.text === "string") streamed.set(id, fields.text)
        changes = [
          {
            kind: "item",
            item: {
              id,
              turnId,
              role: fields.role,
              type: fields.type,
              name: fields.name ?? fields.event ?? fields.label ?? "",
              state: complete ? "complete" : "streaming",
              provenance: fields.provenance,
              content: observed(fields, Object.hasOwn(fields, "text") ? "text" : "data"),
              input: observed(fields, "input"),
              result: observed(fields, "output"),
              ...(fields.type === "toolCall" && fields.nativeItemId !== undefined
                ? { toolCallId: alias("tool", fields.nativeItemId) }
                : {}),
            },
          },
        ]
        break
      }
      case "message.delta": {
        const itemId = nativeItems.get(`${turnId}:${text(fields.nativeItemId)}`)
        if (!itemId || typeof fields.delta !== "string")
          throw new Error("Delta item mapping missing")
        const assembled = (streamed.get(itemId) ?? "") + fields.delta
        assertSafeText(assembled)
        streamed.set(itemId, assembled)
        changes = [{ kind: "delta", itemId, text: fields.delta }]
        break
      }
      case "runtime_request.opened":
      case "runtime_request.resolved":
      case "runtime_request.expired":
        changes = [
          {
            kind: "request",
            request: {
              id: alias("request", fields.id),
              turnId,
              kind: fields.kind,
              state: fields.state,
              prompt: observed(fields, "prompt"),
              decision: { available: false },
            },
          },
        ]
        break
      default:
        throw new Error(`Unsupported recording event at index ${sequence}`)
    }
    assertSafeValues(changes)
    return { sequence, sourceSequence: event.sourceSequence, elapsedMs: event.elapsedMs, changes }
  })
  const capture = parseCapture(
    JSON.stringify({
      version: 1,
      ...meta,
      recordedAt: raw.recordedAt,
      initial: { turns: [], items: [], requests: [], notices: [] },
      events,
      moments: [],
    }),
  )
  const end = stateAt(capture, capture.events.length - 1)
  if (
    end.turns.some((t) => t.status !== "terminal") ||
    end.requests.some((r) => r.state === "pending")
  )
    throw new Error("Recording is not settled")
  return capture
}
