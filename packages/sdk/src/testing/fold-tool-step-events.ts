import {
  B4_ANSWER_METADATA_KEY,
  B4_STEP_EVENT_NAME,
  B4_STEP_METADATA_KEY,
  type B4AnswerAnnotations,
  type B4ToolStep,
  type B4ToolStepUpdate,
  mergeToolStep,
  readAnswerAnnotations,
  readToolStepUpdate,
  settleOpenSteps,
} from "../tool-step.js"

/**
 * A structural subset of an AG-UI event: a `type` string plus the fields the
 * tool-step contract reads. Declared here so the SDK needs no `@ag-ui/core`.
 */
export interface ToolStepFixtureEvent {
  readonly type: string
  readonly toolCallId?: string
  readonly toolCallName?: string
  readonly messageId?: string
  /** `CUSTOM` event name. */
  readonly name?: string
  /** `CUSTOM` event value. */
  readonly value?: unknown
  readonly content?: string
  /** Tool-call and message metadata, keyed by `b4.step` / `b4.answer`. */
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Epoch ms; the settle time for `RUN_ERROR` and `RUN_FINISHED`. */
  readonly timestamp?: number
  /** `RUN_FINISHED` outcome, as a type string or `{ type, pendingToolCallIds? }`. */
  readonly outcome?:
    | string
    | { readonly type: string; readonly pendingToolCallIds?: readonly string[] }
  /** Calls still waiting on an interrupt; they stay open when the run finishes. */
  readonly pendingToolCallIds?: readonly string[]
}

/** The per-call view a fixture expects after folding its events. */
export interface ToolStepFolded {
  readonly steps: Readonly<Record<string, B4ToolStep>>
  readonly answers?: Readonly<Record<string, B4AnswerAnnotations>>
}

type FrameStatus = "running" | "completed"

interface Fold {
  readonly steps: Record<string, B4ToolStep>
  readonly frame: Record<string, FrameStatus>
  /** Ids whose step status came from the frames, not from a producer. */
  readonly derived: Set<string>
  /** Updates held for ids whose START has not arrived. */
  readonly held: Record<string, B4ToolStepUpdate[]>
  readonly answers: Record<string, B4AnswerAnnotations>
}

function stripId(step: B4ToolStep): B4ToolStep {
  const { toolCallId: _toolCallId, ...rest } = step
  return rest
}

function applyUpdate(
  fold: Fold,
  id: string,
  update: B4ToolStepUpdate,
  source: "call" | "message",
): void {
  const previous = fold.steps[id]
  const frame = fold.frame[id] ?? "running"
  const seeded: B4ToolStepUpdate =
    previous === undefined && update.status === undefined ? { ...update, status: frame } : update
  const merged = stripId(mergeToolStep(previous, seeded, source))
  fold.steps[id] = merged
  if (update.status !== undefined) fold.derived.delete(id)
  else if (previous === undefined) fold.derived.add(id)
}

function applyMetadata(
  fold: Fold,
  id: string,
  metadata: ToolStepFixtureEvent["metadata"],
  source: "call" | "message",
): void {
  const update = readToolStepUpdate(metadata?.[B4_STEP_METADATA_KEY], id)
  if (update !== undefined) applyUpdate(fold, id, update, source)
}

function startCall(fold: Fold, id: string): void {
  if (fold.frame[id] === undefined) fold.frame[id] = "running"
  for (const held of fold.held[id] ?? []) applyUpdate(fold, id, held, "call")
  delete fold.held[id]
}

/** Gives every seen call that still has no step the one its frames imply. */
function materialize(fold: Fold): void {
  for (const [id, frame] of Object.entries(fold.frame)) {
    if (fold.steps[id] === undefined) {
      fold.steps[id] = { v: 1, kind: "server", status: frame }
      fold.derived.add(id)
    }
  }
}

function settle(
  fold: Fold,
  outcome: "failed" | "cancelled",
  keepOpen: ReadonlySet<string>,
  at: number,
): void {
  materialize(fold)
  const settled = settleOpenSteps(fold.steps, outcome, keepOpen, at)
  for (const [id, step] of Object.entries(settled)) {
    fold.steps[id] = step
    if (step.status !== "running") fold.derived.delete(id)
  }
}

function pendingIds(event: ToolStepFixtureEvent): ReadonlySet<string> {
  const nested = typeof event.outcome === "object" ? event.outcome.pendingToolCallIds : undefined
  return new Set([...(event.pendingToolCallIds ?? []), ...(nested ?? [])])
}

function outcomeType(event: ToolStepFixtureEvent): string | undefined {
  return typeof event.outcome === "string" ? event.outcome : event.outcome?.type
}

/**
 * The reference semantics of the tool-step contract. Folds an AG-UI event
 * stream into the per-call step view and the per-message answer annotations.
 *
 * - The frames supply the lifecycle: `TOOL_CALL_START` through
 *   `TOOL_CALL_RESULT` is `running`, and the result makes it `completed`.
 * - `b4.step` metadata (call frames merge as the call, the result as the
 *   message) and `CUSTOM` `b4.step` events merge with {@link mergeToolStep}.
 *   Updates are read with `readToolStepUpdate`, so a legacy value never
 *   overwrites a stored `provider` kind.
 * - A `CUSTOM` step for an id not yet started is held until its START.
 * - `RUN_ERROR` settles open steps as `failed`; a `RUN_FINISHED` with a
 *   `cancelled` or `interrupt` outcome settles them as `cancelled`, except
 *   `pendingToolCallIds`. The event's `timestamp` is the settle time.
 * - A call with no step at all becomes `{ v: 1, kind: "server", status }`.
 * - `toolCallId` is the record key, so it is left off the stored steps.
 *
 * Pure: it does not mutate its input.
 */
export function foldToolStepEvents(events: readonly ToolStepFixtureEvent[]): ToolStepFolded {
  const fold: Fold = { steps: {}, frame: {}, derived: new Set(), held: {}, answers: {} }

  for (const event of events) {
    const id = event.toolCallId
    switch (event.type) {
      case "TOOL_CALL_START":
        if (id === undefined) break
        startCall(fold, id)
        applyMetadata(fold, id, event.metadata, "call")
        break
      case "TOOL_CALL_END":
        if (id === undefined) break
        applyMetadata(fold, id, event.metadata, "call")
        break
      case "TOOL_CALL_RESULT":
        if (id === undefined) break
        startCall(fold, id)
        fold.frame[id] = "completed"
        if (fold.derived.has(id) && fold.steps[id]?.status === "running") {
          fold.steps[id] = { ...fold.steps[id], status: "completed" }
        }
        applyMetadata(fold, id, event.metadata, "message")
        break
      case "CUSTOM": {
        if (event.name !== B4_STEP_EVENT_NAME) break
        const update = readToolStepUpdate(event.value)
        const target =
          update?.toolCallId ??
          (typeof event.value === "object" && event.value !== null
            ? (event.value as { toolCallId?: unknown }).toolCallId
            : undefined)
        if (update === undefined || typeof target !== "string") break
        const withId = readToolStepUpdate(event.value, target) ?? update
        if (fold.frame[target] === undefined) {
          fold.held[target] = [...(fold.held[target] ?? []), withId]
        } else {
          applyUpdate(fold, target, withId, "call")
        }
        break
      }
      case "TEXT_MESSAGE_START":
      case "TEXT_MESSAGE_END": {
        const answer = readAnswerAnnotations(event.metadata?.[B4_ANSWER_METADATA_KEY])
        if (event.messageId !== undefined && answer !== undefined) {
          fold.answers[event.messageId] = answer
        }
        break
      }
      case "RUN_ERROR":
        settle(fold, "failed", new Set(), event.timestamp ?? 0)
        break
      case "RUN_FINISHED": {
        const type = outcomeType(event)
        if (type === "cancelled" || type === "interrupt") {
          settle(fold, "cancelled", pendingIds(event), event.timestamp ?? 0)
        }
        break
      }
      default:
        break
    }
  }

  materialize(fold)
  return {
    steps: fold.steps,
    ...(Object.keys(fold.answers).length > 0 ? { answers: fold.answers } : {}),
  }
}
