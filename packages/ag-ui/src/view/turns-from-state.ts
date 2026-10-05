import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import {
  B4_STEP_KEY,
  B4_SUBAGENT_KEY,
  B4_TURN_METADATA_KEY,
  type PersistedStep,
  type PersistedTurnEnd,
  readPersistedStep,
  readPersistedSubagent,
  readPersistedTurnEnd,
} from "@b4run/sdk"
import { B4_PLAN_ACTIVITY_TYPE, type B4PlanActivityContent } from "../activities.js"
import { toAguiInterrupt } from "../interrupts.js"
import { B4_STEP_EVENT_NAME } from "../step.js"
import { readPlan } from "./subagent-runs.js"
import { reduceTurns, type TurnsView } from "./turns.js"

/** One decoded checkpoint of one namespace, oldest first in a history. */
export interface CheckpointForTurns {
  readonly id: string
  /** The checkpoint's own timestamp (ISO). */
  readonly ts: string
  readonly metadata: Readonly<Record<string, unknown>> | null | undefined
  readonly values: { readonly messages?: unknown; readonly todos?: unknown }
}

/** A parked interrupt in the shape `GET /threads/:id/pending_interrupts` returns. */
export interface PendingInterruptForTurns {
  readonly interruptId: string
  readonly value?: unknown
  /** The single-use approval grant, when the runtime minted one; re-readable on purpose. */
  readonly grant?: string
}

/** What `GET /threads/:id/turns` assembles (spec §3); plain JSON, never class instances. */
export interface ThreadStateForTurns {
  readonly threadId: string
  readonly status: "idle" | "busy" | "interrupted"
  /** The root namespace's history, oldest first. */
  readonly root: readonly CheckpointForTurns[]
  /** Child namespaces (`tools:<task id>`) and their histories, oldest first. */
  readonly children: Readonly<Record<string, readonly CheckpointForTurns[]>>
  readonly pendingInterrupts: readonly PendingInterruptForTurns[]
}

export interface TurnsFromStateResult {
  readonly turns: TurnsView
  /** One line per ignored stamp or unattached child namespace. */
  readonly warnings: readonly string[]
}

type Timed = { readonly at: number; readonly event: BaseEvent }

interface Envelope {
  readonly cls: string
  readonly kwargs: Record<string, unknown>
}

interface PlanChange {
  readonly at: number
  readonly todos: B4PlanActivityContent["todos"]
  /** The snapshot lands before this message: the first one its checkpoint added. */
  readonly beforeMessage: number
}

interface Synth {
  readonly events: Timed[]
  readonly warnings: string[]
  /** Child namespaces a `task` message named, so the rest can be reported. */
  readonly attached: Set<string>
}

/** The one built-in tool whose root frames the live ledger replaces with the plan snapshot. */
const PLAN_TOOL = "writeTodos"

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** The LangChain class name and kwargs of a serialized message, or undefined. */
function envelope(value: unknown): Envelope | undefined {
  if (!isRecord(value) || !Array.isArray(value.id) || !isRecord(value.kwargs)) return undefined
  const cls = value.id.at(-1)
  return typeof cls === "string" ? { cls, kwargs: value.kwargs } : undefined
}

/** Epoch ms of an ISO string, or 0 when it does not parse (the view then shows the epoch, not NaN). */
function ms(iso: unknown): number {
  const t = typeof iso === "string" ? Date.parse(iso) : Number.NaN
  return Number.isNaN(t) ? 0 : t
}

const messagesOf = (cp: CheckpointForTurns | undefined): readonly unknown[] => {
  const list = cp?.values?.messages
  return Array.isArray(list) ? list : []
}

/** Text of a message's content: a string, or the `text` parts of a block array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("")
}

/** Reasoning text of a message's content blocks (`thinking`/`reasoning`), joined. */
function reasoningOf(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => {
      if (!isRecord(b)) return ""
      if (b.type === "thinking" && typeof b.thinking === "string") return b.thinking
      if (b.type === "reasoning" && typeof b.reasoning === "string") return b.reasoning
      return ""
    })
    .join("")
}

function stringifyArgs(args: unknown): string {
  if (typeof args === "string") return args
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return "{}"
  }
}

function push(s: Synth, at: number, event: BaseEvent, owner?: string): void {
  s.events.push({
    at,
    event: owner === undefined ? event : ({ ...event, subagentRunId: owner } as BaseEvent),
  })
}

/**
 * The plan snapshots a history implies: one per checkpoint whose `todos`
 * differ from the previous checkpoint's, placed before the first message that
 * checkpoint added (the tool node writes `todos` in the same superstep as the
 * ToolMessages, so live showed the snapshot after the model's frames and
 * among the results). A history that starts with an empty plan has nothing to
 * show until it changes.
 */
function planChanges(history: readonly CheckpointForTurns[]): PlanChange[] {
  const changes: PlanChange[] = []
  let previous = "null"
  let previousCount = 0
  for (const cp of history) {
    const todos = readPlan({ todos: cp.values?.todos })
    const key = JSON.stringify(todos ?? null)
    if (todos !== undefined && key !== previous && !(previous === "null" && todos.length === 0)) {
      changes.push({ at: ms(cp.ts), todos, beforeMessage: previousCount })
    }
    previous = key
    previousCount = messagesOf(cp).length
  }
  return changes
}

/**
 * Emit the events one namespace's history would have streamed. Messages are
 * walked once (the last checkpoint holds the full list); the checkpoint that
 * first contained each message gives it a time. The root namespace frames its
 * turns with `RUN_*`; a child's turn is framed by its parent's `SUBAGENT_*`
 * instead, since the reducer resets on a foreign `RUN_STARTED` and always
 * lands `RUN_FINISHED`/`RUN_ERROR` on the root turn.
 */
function synthesiseNamespace(
  s: Synth,
  input: ThreadStateForTurns,
  history: readonly CheckpointForTurns[],
  owner: string | undefined,
): void {
  if (history.length === 0) return
  const nested = owner !== undefined
  const last = history.at(-1) as CheckpointForTurns
  const messages = messagesOf(last)
  const where = owner ?? "root"

  // When each message first appeared: the ts of the first checkpoint whose list is long enough.
  const firstSeenAt = (index: number): number => {
    for (const cp of history) if (messagesOf(cp).length > index) return ms(cp.ts)
    return ms(last.ts)
  }

  const plans = planChanges(history)
  const pendingPlans = [...plans]
  /** Whether a plan snapshot follows the message at `index` (so the live ledger suppressed its `writeTodos` frames). */
  const planFollows = (index: number): boolean => plans.some((p) => p.beforeMessage > index)

  let openRun: string | undefined
  let openRunStart = 0

  /** The `b4:turn` stamp on the turn's own checkpoints (those past its user message, before the next). */
  const endOf = (
    start: number,
    upTo: number,
  ): { at: number; end: PersistedTurnEnd } | undefined => {
    for (let i = history.length - 1; i >= 0; i--) {
      const cp = history[i] as CheckpointForTurns
      const count = messagesOf(cp).length
      if (count > upTo) continue
      if (count <= start) break
      const stamp = isRecord(cp.metadata) ? cp.metadata[B4_TURN_METADATA_KEY] : undefined
      const end = readPersistedTurnEnd(stamp)
      if (end) return { at: ms(end.endedAt), end }
      if (stamp !== undefined) {
        s.warnings.push(`ignored malformed ${B4_TURN_METADATA_KEY} on checkpoint ${cp.id}`)
      }
    }
    return undefined
  }

  /** The ts of the turn's last checkpoint: the latest one holding no message past `upTo`. */
  const lastCheckpointAt = (upTo: number): number => {
    for (let i = history.length - 1; i >= 0; i--) {
      const cp = history[i] as CheckpointForTurns
      if (messagesOf(cp).length <= upTo) return ms(cp.ts)
    }
    return ms(last.ts)
  }

  /** Close the open turn (its messages end before `upTo`): `head` when it is the history's last, the only one that can still be running. */
  const closeRun = (upTo: number, head: boolean): void => {
    if (openRun === undefined) return
    const runId = openRun
    openRun = undefined
    if (nested) return
    const threadId = input.threadId
    const resolved = endOf(openRunStart, upTo)
    const lastAt = lastCheckpointAt(upTo)
    const parked =
      head && input.status === "interrupted" && (input.pendingInterrupts ?? []).length > 0
    if (parked) {
      const interrupts = (input.pendingInterrupts ?? []).flatMap((p) => {
        const interrupt = toAguiInterrupt(p.value)
        if (interrupt === null) return []
        return typeof p.grant === "string"
          ? [{ ...interrupt, metadata: { ...interrupt.metadata, grant: p.grant } }]
          : [interrupt]
      })
      const event = {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: { type: "interrupt", interrupts },
      }
      push(s, lastAt, event as BaseEvent)
    } else if (resolved?.end.status === "failed") {
      const message = resolved.end.error ?? "The run failed."
      push(s, resolved.at, { type: EventType.RUN_ERROR, threadId, runId, message } as BaseEvent)
    } else if (resolved?.end.status === "stopped") {
      const event = {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: { type: "cancelled" },
      }
      push(s, resolved.at, event as BaseEvent)
    } else if (resolved !== undefined || !head || input.status !== "busy") {
      // No stamp on a turn that is not the running head: the run ended before
      // the stamp existed, or its stamp was lost; the turn still ended, at its
      // last checkpoint.
      const event = { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: "success" } }
      push(s, resolved?.at ?? lastAt, event as BaseEvent)
    }
    // A busy head with no stamp is the turn still running: leave it open.
  }

  const flushPlans = (beforeMessage: number): void => {
    while (
      pendingPlans.length > 0 &&
      (pendingPlans[0] as PlanChange).beforeMessage <= beforeMessage
    ) {
      const plan = pendingPlans.shift() as PlanChange
      if (openRun === undefined) continue
      const event = {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: `b4:plan:${openRun}`,
        activityType: B4_PLAN_ACTIVITY_TYPE,
        replace: true,
        content: { todos: plan.todos },
      }
      push(s, plan.at, event as BaseEvent, owner)
    }
  }

  for (let index = 0; index < messages.length; index++) {
    const message = envelope(messages[index])
    const at = firstSeenAt(index)
    if (!message) {
      s.warnings.push(`ignored unreadable message ${index} in ${where}`)
      continue
    }
    const { cls, kwargs } = message
    const id = typeof kwargs.id === "string" && kwargs.id !== "" ? kwargs.id : `${where}:${index}`

    if (cls === "HumanMessage") {
      if (nested && openRun !== undefined) continue // a nested run has one user message
      flushPlans(index)
      closeRun(index, false)
      openRun = id
      openRunStart = index
      if (!nested) {
        push(s, at, {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: id,
        } as BaseEvent)
      }
      continue
    }
    if (openRun === undefined) continue
    flushPlans(index)

    if (cls === "AIMessage" || cls === "AIMessageChunk") {
      const reasoning = reasoningOf(kwargs.content)
      if (reasoning !== "") {
        const span = `rspan:${id}`
        const msg = `rsn:${id}`
        push(s, at, { type: EventType.REASONING_START, messageId: span } as BaseEvent, owner)
        push(
          s,
          at,
          {
            type: EventType.REASONING_MESSAGE_START,
            messageId: msg,
            role: "reasoning",
          } as BaseEvent,
          owner,
        )
        push(
          s,
          at,
          {
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: msg,
            delta: reasoning,
          } as BaseEvent,
          owner,
        )
        push(s, at, { type: EventType.REASONING_MESSAGE_END, messageId: msg } as BaseEvent, owner)
        push(s, at, { type: EventType.REASONING_END, messageId: span } as BaseEvent, owner)
      }
      const text = textOf(kwargs.content)
      if (text !== "") {
        push(
          s,
          at,
          { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" } as BaseEvent,
          owner,
        )
        push(
          s,
          at,
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: text } as BaseEvent,
          owner,
        )
        push(s, at, { type: EventType.TEXT_MESSAGE_END, messageId: id } as BaseEvent, owner)
      }
      const calls = Array.isArray(kwargs.tool_calls) ? kwargs.tool_calls : []
      for (const call of calls) {
        if (!isRecord(call) || typeof call.id !== "string" || typeof call.name !== "string")
          continue
        // Live, the root ledger drops a `writeTodos` call's frames once its
        // plan snapshot arrives (a child's frames always flow, and so do the
        // root's when the call produced no plan).
        if (!nested && call.name === PLAN_TOOL && planFollows(index)) continue
        const toolCallId = call.id
        push(
          s,
          at,
          { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: call.name } as BaseEvent,
          owner,
        )
        push(
          s,
          at,
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: stringifyArgs(call.args),
          } as BaseEvent,
          owner,
        )
        push(s, at, { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent, owner)
      }
      continue
    }

    if (cls === "ToolMessage") {
      const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : ""
      if (toolCallId === "") {
        s.warnings.push(`ignored ToolMessage ${index} without tool_call_id in ${where}`)
        continue
      }
      const additional = isRecord(kwargs.additional_kwargs) ? kwargs.additional_kwargs : {}
      const stampValue = additional[B4_STEP_KEY]
      const step = readPersistedStep(stampValue)
      if (step === undefined) {
        const why = stampValue === undefined ? "missing" : "malformed"
        s.warnings.push(`ignored ${why} ${B4_STEP_KEY} on tool call ${toolCallId}`)
      }
      const failed = step?.status === "failed" || kwargs.status === "error"
      const startedAt = step ? ms(step.startedAt) : at
      const settledAt = step ? ms(step.settledAt) : at
      const subagentValue = additional[B4_SUBAGENT_KEY]
      const subagent = readPersistedSubagent(subagentValue)
      if (subagentValue !== undefined && subagent === undefined) {
        s.warnings.push(`ignored malformed ${B4_SUBAGENT_KEY} on tool call ${toolCallId}`)
      }

      if (subagent) {
        push(s, startedAt, {
          type: EventType.SUBAGENT_STARTED,
          subagentRunId: toolCallId,
          name: subagent.name,
          parentToolCallId: toolCallId,
          ...(owner !== undefined ? { parentSubagentRunId: owner } : {}),
          ...(subagent.description !== undefined ? { description: subagent.description } : {}),
        } as BaseEvent)
        s.attached.add(subagent.checkpointNs)
        const child = input.children?.[subagent.checkpointNs]
        if (child === undefined) {
          s.warnings.push(
            `no checkpoints for child namespace ${subagent.checkpointNs} of tool call ${toolCallId}`,
          )
        } else {
          synthesiseNamespace(s, input, child, toolCallId)
        }
        if (subagent.outcome === "failed") {
          const message = subagent.error ?? "The subagent failed."
          push(s, settledAt, {
            type: EventType.SUBAGENT_ERROR,
            subagentRunId: toolCallId,
            message,
          } as BaseEvent)
        } else if (subagent.outcome === "suspended") {
          const event = {
            type: EventType.SUBAGENT_FINISHED,
            subagentRunId: toolCallId,
            outcome: { type: "suspended" },
          }
          push(s, settledAt, event as BaseEvent)
        } else {
          const event = {
            type: EventType.SUBAGENT_FINISHED,
            subagentRunId: toolCallId,
            result: textOf(kwargs.content),
            outcome: { type: "success" },
          }
          push(s, settledAt, event as BaseEvent)
        }
        continue
      }

      const stepEvent = (status: PersistedStep["status"]): BaseEvent =>
        ({
          type: EventType.CUSTOM,
          name: B4_STEP_EVENT_NAME,
          value: {
            toolCallId,
            status,
            ...(step?.icon !== undefined ? { icon: step.icon } : {}),
            ...(step?.label !== undefined ? { label: step.label } : {}),
            ...(step?.sources !== undefined ? { sources: step.sources } : {}),
          },
        }) as BaseEvent
      // Live order: a `completed` step precedes its result; a `failed` step follows it.
      if (step !== undefined && !failed) push(s, settledAt, stepEvent("completed"), owner)
      const result = {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId,
        messageId: `tr:${id}`,
        content: textOf(kwargs.content),
      }
      push(s, settledAt, result as BaseEvent, owner)
      if (failed) push(s, settledAt, stepEvent("failed"), owner)
    }
    // System/developer envelopes are prompt plumbing.
  }
  flushPlans(Number.POSITIVE_INFINITY)
  closeRun(messages.length, true)
}

/**
 * The turns of a thread, rebuilt from its checkpoint chain (spec §3): the AG-UI
 * events the live stream would have carried are synthesised and folded
 * through the unchanged `reduceTurns`, with the clock driven by the stamped
 * and checkpoint times. Stamps that are missing or malformed are ignored and
 * named in `warnings`; the function never throws.
 */
export function turnsFromState(input: ThreadStateForTurns): TurnsFromStateResult {
  const s: Synth = { events: [], warnings: [], attached: new Set() }
  let view: TurnsView = { threadId: input.threadId, turns: [] }
  try {
    synthesiseNamespace(s, input, input.root ?? [], undefined)
    for (const ns of Object.keys(input.children ?? {})) {
      if (!s.attached.has(ns))
        s.warnings.push(`child namespace ${ns} is not named by any task message`)
    }
    // Events are already in message order; a stable sort by time keeps parallel
    // calls in that order while placing a late-settling result after an earlier one.
    const ordered = s.events.map((e, i) => ({ ...e, i })).sort((a, b) => a.at - b.at || a.i - b.i)
    let clock = 0
    const now = () => clock
    for (const { at, event } of ordered) {
      clock = at
      view = reduceTurns(view, event, { now, resuming: false })
    }
  } catch (error) {
    s.warnings.push(`synthesis stopped: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { turns: view, warnings: s.warnings }
}
