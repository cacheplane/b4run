import type { BaseEvent } from "@ag-ui/core"
import { EventType, PROTOCOL_VERSION } from "@ag-ui/core"
import {
  B4_STEP_KEY,
  B4_SUBAGENT_KEY,
  B4_TURN_METADATA_KEY,
  isToolDisplayIcon,
  type PersistedStep,
  type PersistedTurnEnd,
  readPersistedStep,
  readPersistedSubagent,
  readPersistedTurnEnd,
} from "@b4run/sdk"
import { B4_PLAN_ACTIVITY_TYPE, type B4PlanActivityContent } from "../activities.js"
import { toAguiInterrupt } from "../interrupts.js"
import { B4_STEP_EVENT_NAME } from "../step.js"
import { blocksToParts, keptToolParts, mediaPartsOf } from "./parts.js"
import { readPlan } from "./plan.js"
import { EMPTY_TURNS, reduceTurns, type TurnsView } from "./turns.js"

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
  /**
   * One line per reason: an unattached or missing child namespace, a malformed
   * message, stamp or turn end, a clamped clock, a rejected input shape — and
   * one aggregated line per reason for the tool calls whose `b4_step` was
   * missing or malformed.
   */
  readonly warnings: readonly string[]
}

export interface EventsFromStateResult {
  /** The thread as the AG-UI stream its live runs would have carried, in order, each with `timestamp`. */
  readonly events: readonly BaseEvent[]
  /** The same lines `turnsFromState` reports. */
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

/** The input after shape checks: every collection is a real one, so the walk never guards. */
interface Normalised {
  readonly threadId: string
  readonly status: ThreadStateForTurns["status"]
  readonly root: readonly CheckpointForTurns[]
  readonly children: Readonly<Record<string, readonly CheckpointForTurns[]>>
  readonly pendingInterrupts: readonly Record<string, unknown>[]
}

interface Synth {
  readonly events: Timed[]
  readonly warnings: string[]
  /** Tool calls whose `b4_step` was unusable, by reason; reported as one line per reason. */
  readonly unstamped: { readonly missing: string[]; readonly malformed: string[] }
  /** Child namespaces a `task` call claimed, so the rest can be reported. */
  readonly attached: Set<string>
  /** Subagent run ids (task call ids) started and not yet finished, in start order. */
  readonly open: string[]
  /**
   * The root turn being synthesised and the end of the turn before it: no
   * event of that turn (its children's included) is timed earlier, so each
   * root turn stays contiguous under the sort. A skewed clock is clamped once
   * per turn, with a warning.
   */
  readonly turnFloor: { at: number; runId: string | undefined; clamped: Set<string> }
}

/** An interrupt as the `RUN_FINISHED` outcome carries it. */
type OutcomeInterrupt = NonNullable<ReturnType<typeof toAguiInterrupt>>

/** Why the still-open subagents close when a root turn ends: `outbound.ts`'s `SubagentCloseReason` kinds. */
type CloseReason =
  | { readonly kind: "interrupt"; readonly interrupts: readonly OutcomeInterrupt[] }
  | { readonly kind: "unterminated" }
  | { readonly kind: "cancelled" }

/** The one built-in tool whose root frames the live ledger replaces with the plan snapshot. */
const PLAN_TOOL = "writeTodos"
/** The built-in tool that launches a subagent; its child checkpoints under its own namespace. */
const TASK_TOOL = "task"

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
  const list = isRecord(cp?.values) ? cp.values.messages : undefined
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

/**
 * The `running` step of a parked call: the running display (`step`) its
 * permission interrupt carries, which the runtime streamed live as the call's
 * `b4.step` before the gate parked it. A parked call has no ToolMessage to
 * stamp, so the interrupt is where the checkpoint keeps it. Undefined when the
 * thread is not parked on this call or the interrupt carries no display.
 */
function parkedStep(input: Normalised, toolCallId: string): BaseEvent | undefined {
  if (input.status !== "interrupted") return undefined
  for (const pending of input.pendingInterrupts) {
    const interrupt = toAguiInterrupt(pending.value)
    if (interrupt?.toolCallId !== toolCallId) continue
    const step = isRecord(interrupt.metadata) ? interrupt.metadata.step : undefined
    if (!isRecord(step)) return undefined
    const { icon, label } = step
    const display = {
      ...(isToolDisplayIcon(icon) ? { icon } : {}),
      ...(typeof label === "string" && label !== "" ? { label } : {}),
    }
    if (Object.keys(display).length === 0) return undefined
    return {
      type: EventType.CUSTOM,
      name: B4_STEP_EVENT_NAME,
      value: { toolCallId, status: "running", ...display },
    } as BaseEvent
  }
  return undefined
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

/**
 * A user message's content as a client sends it: the text, or — when the
 * checkpoint holds media blocks — the AG-UI part list they map back to, the
 * shape a multimodal client put in `RunAgentInput.messages`.
 */
function userContent(content: unknown): string | ReturnType<typeof blocksToParts> {
  const parts = blocksToParts(content)
  return mediaPartsOf(parts).length > 0 ? parts : textOf(content)
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
  const floor = s.turnFloor
  if (at < floor.at && floor.runId !== undefined && !floor.clamped.has(floor.runId)) {
    floor.clamped.add(floor.runId)
    s.warnings.push(`clamped clocks on turn ${floor.runId} to the end of the turn before it`)
  }
  s.events.push({
    at: Math.max(at, floor.at),
    event: owner === undefined ? event : ({ ...event, subagentRunId: owner } as BaseEvent),
  })
}

/**
 * Close the subagents still open when a root turn ends, newest first, as
 * `outbound.ts` does live: an interrupt suspends them, naming the interrupts
 * each raised; anything else fails them. Returns the ids that were open.
 */
function closeOpen(s: Synth, at: number, reason: CloseReason): ReadonlySet<string> {
  const closed = new Set<string>()
  for (const id of [...s.open].reverse()) {
    closed.add(id)
    if (reason.kind === "interrupt") {
      const interruptIds = reason.interrupts
        .filter((i) => (i.subagentRunId ?? i.toolCallId) === id)
        .map((i) => i.id)
      push(s, at, {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: id,
        outcome: { type: "suspended", ...(interruptIds.length > 0 ? { interruptIds } : {}) },
      } as BaseEvent)
    } else {
      push(s, at, {
        type: EventType.SUBAGENT_ERROR,
        subagentRunId: id,
        message:
          reason.kind === "cancelled"
            ? "The run was cancelled."
            : "The run ended before the subagent finished.",
        code: reason.kind,
      } as BaseEvent)
    }
  }
  s.open.length = 0
  return closed
}

/** The `b4_step` of a ToolMessage envelope's `additional_kwargs`, when it names this tool. */
function stampOf(kwargs: Record<string, unknown>, key: string): unknown {
  return isRecord(kwargs.additional_kwargs) ? kwargs.additional_kwargs[key] : undefined
}

/** The content of a namespace's first user message: what its `task` call was invoked with. */
function firstUserText(history: readonly CheckpointForTurns[]): string | undefined {
  for (const value of messagesOf(history.at(-1))) {
    const message = envelope(value)
    if (message?.cls === "HumanMessage") return textOf(message.kwargs.content)
  }
  return undefined
}

/**
 * The plan snapshots a history implies: one per checkpoint whose `todos`
 * differ from the previous checkpoint's, placed before the first message that
 * checkpoint added (the tool node writes `todos` in the same superstep as the
 * ToolMessages, so live showed the snapshot after the model's frames and
 * among the results), timed by the `writeTodos` result that checkpoint holds
 * when it has one, else by the checkpoint. A history that starts with an
 * empty plan has nothing to show until it changes.
 */
function planChanges(history: readonly CheckpointForTurns[]): PlanChange[] {
  const changes: PlanChange[] = []
  let previous = "null"
  let previousCount = 0
  let previousTs = 0
  for (const cp of history) {
    const todos = readPlan({ todos: isRecord(cp.values) ? cp.values.todos : undefined })
    const key = JSON.stringify(todos ?? null)
    const messages = messagesOf(cp)
    if (todos !== undefined && key !== previous && !(previous === "null" && todos.length === 0)) {
      let at = ms(cp.ts)
      for (const value of messages.slice(previousCount)) {
        const message = envelope(value)
        if (message?.cls !== "ToolMessage" || message.kwargs.name !== PLAN_TOOL) continue
        const step = readPersistedStep(stampOf(message.kwargs, B4_STEP_KEY))
        if (step !== undefined) at = Math.max(ms(step.settledAt), previousTs)
        break
      }
      changes.push({ at, todos, beforeMessage: previousCount })
    }
    previous = key
    previousCount = messages.length
    previousTs = ms(cp.ts)
  }
  return changes
}

/**
 * Emit the events one namespace's history would have streamed. Messages are
 * walked once (the last checkpoint holds the full list); the checkpoint that
 * first contained each message gives it a time, never before `floor` (a
 * child's events never precede the `SUBAGENT_STARTED` that frames them). The
 * root namespace frames its turns with `RUN_*`; a child's turn is framed by
 * its parent's `SUBAGENT_*` instead, since the reducer resets on a foreign
 * `RUN_STARTED` and always lands `RUN_FINISHED`/`RUN_ERROR` on the root turn.
 */
function synthesiseNamespace(
  s: Synth,
  input: Normalised,
  history: readonly CheckpointForTurns[],
  owner: string | undefined,
  floor: number,
): void {
  if (history.length === 0) return
  const nested = owner !== undefined
  const last = history.at(-1) as CheckpointForTurns
  const messages = messagesOf(last)
  const where = owner ?? "root"

  // When each message first appeared: the ts of the first checkpoint whose list is long enough.
  const firstSeenAt = (index: number): number => {
    for (const cp of history) {
      if (messagesOf(cp).length > index) return Math.max(ms(cp.ts), floor)
    }
    return Math.max(ms(last.ts), floor)
  }

  // Tool calls that have a ToolMessage; a `task` call without one is a child still running or parked.
  const answered = new Set<string>()
  /** When the model announced each call: the floor for that call's stamped clocks. */
  const announcedAt = new Map<string, number>()
  const humanIndices: number[] = []
  messages.forEach((value, index) => {
    const message = envelope(value)
    if (message?.cls === "ToolMessage" && typeof message.kwargs.tool_call_id === "string") {
      answered.add(message.kwargs.tool_call_id)
      // A namespace an answered task owns is spoken for before any open call looks for one.
      const owned = readPersistedSubagent(stampOf(message.kwargs, B4_SUBAGENT_KEY))
      if (owned !== undefined) s.attached.add(owned.checkpointNs)
    }
    if (message?.cls === "HumanMessage") humanIndices.push(index)
    if (message?.cls === "AIMessage" || message?.cls === "AIMessageChunk") {
      const calls = Array.isArray(message.kwargs.tool_calls) ? message.kwargs.tool_calls : []
      for (const call of calls) {
        if (isRecord(call) && typeof call.id === "string")
          announcedAt.set(call.id, firstSeenAt(index))
      }
    }
  })
  /** The index of the user message that ends the turn holding `index`, else the end. */
  const nextHuman = (index: number): number =>
    humanIndices.find((i) => i > index) ?? messages.length

  const plans = planChanges(history)
  const pendingPlans = [...plans]
  /** Whether this turn has a plan snapshot after the message at `index` (so the live ledger suppressed its `writeTodos` frames). */
  const planFollows = (index: number): boolean => {
    const end = nextHuman(index)
    return plans.some((p) => p.beforeMessage > index && p.beforeMessage <= end)
  }

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
      if (messagesOf(cp).length <= upTo) return Math.max(ms(cp.ts), floor)
    }
    return Math.max(ms(last.ts), floor)
  }

  /** Close the open turn (its messages end before `upTo`): `head` when it is the history's last, the only one that can still be running. */
  const closeRun = (upTo: number, head: boolean): void => {
    if (openRun === undefined) return
    const runId = openRun
    openRun = undefined
    if (nested) return
    const threadId = input.threadId
    const resolved = endOf(openRunStart, upTo)
    // A turn never ends before its own events: a child's frames may postdate
    // the root's last checkpoint, and a skewed `b4:turn.endedAt` could land
    // before a step settled — either would make the reducer fail that step.
    const latest = s.events.reduce((max, e) => Math.max(max, e.at), 0)
    const lastAt = Math.max(lastCheckpointAt(upTo), latest)
    const endAt = resolved === undefined ? lastAt : Math.max(resolved.at, latest)
    const parked = head && input.status === "interrupted" && input.pendingInterrupts.length > 0
    if (parked) {
      const interrupts = input.pendingInterrupts.flatMap((p): OutcomeInterrupt[] => {
        const interrupt = toAguiInterrupt(p.value)
        if (interrupt === null) return []
        return typeof p.grant === "string"
          ? [{ ...interrupt, metadata: { ...interrupt.metadata, grant: p.grant } }]
          : [interrupt]
      })
      // Live `finishInterrupted`: suspend the open children, then attribute each interrupt a suspended child raised.
      const suspended = closeOpen(s, lastAt, { kind: "interrupt", interrupts })
      const event = {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: {
          type: "interrupt",
          interrupts: interrupts.map((interrupt) => {
            const run = interrupt.subagentRunId ?? interrupt.toolCallId
            return run !== undefined && suspended.has(run) && interrupt.subagentRunId === undefined
              ? { ...interrupt, subagentRunId: run }
              : interrupt
          }),
        },
      }
      push(s, lastAt, event as BaseEvent)
    } else if (resolved?.end.status === "failed") {
      const message = resolved.end.error ?? "The run failed."
      // Live, RUN_ERROR abandons open subagents (the reducer fails them with its message): nothing closes them.
      s.open.length = 0
      push(s, endAt, { type: EventType.RUN_ERROR, threadId, runId, message } as BaseEvent)
    } else if (resolved?.end.status === "stopped") {
      closeOpen(s, endAt, { kind: "cancelled" })
      const event = {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: { type: "cancelled" },
      }
      push(s, endAt, event as BaseEvent)
    } else if (resolved !== undefined || !head || input.status !== "busy") {
      // No stamp on a turn that is not the running head: the run ended before
      // the stamp existed, or its stamp was lost; the turn still ended, at its
      // last checkpoint.
      closeOpen(s, endAt, { kind: "unterminated" })
      const event = { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: "success" } }
      push(s, endAt, event as BaseEvent)
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
        // Live keys the plan by its owner: the task call for a child, the run for the root.
        messageId: `b4:plan:${owner ?? openRun}`,
        activityType: B4_PLAN_ACTIVITY_TYPE,
        replace: true,
        content: { todos: plan.todos },
      }
      push(s, Math.max(plan.at, floor), event as BaseEvent, owner)
    }
  }

  /**
   * Open a subagent under `toolCallId` and synthesise its namespace, framed by
   * that start. Returns the time of the child's latest event (0 when none), so
   * the subagent never finishes before its own frames.
   */
  const openSubagent = (
    toolCallId: string,
    at: number,
    name: string,
    description: string | undefined,
    checkpointNs: string | undefined,
    child: readonly CheckpointForTurns[] | undefined,
  ): number => {
    push(s, at, {
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: toolCallId,
      name,
      parentToolCallId: toolCallId,
      ...(owner !== undefined ? { parentSubagentRunId: owner } : {}),
      ...(description !== undefined ? { description } : {}),
    } as BaseEvent)
    s.open.push(toolCallId)
    if (checkpointNs !== undefined) s.attached.add(checkpointNs)
    const before = s.events.length
    if (child !== undefined) synthesiseNamespace(s, input, child, toolCallId, at)
    return s.events.slice(before).reduce((max, e) => Math.max(max, e.at), 0)
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
        s.turnFloor.at = s.events.reduce((max, e) => Math.max(max, e.at), 0)
        s.turnFloor.runId = id
        // Live carries the protocol version; the input is what puts the user's message in a client's list.
        push(s, at, {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: id,
          protocolVersion: PROTOCOL_VERSION,
          input: {
            threadId: input.threadId,
            runId: id,
            messages: [{ id, role: "user", content: userContent(kwargs.content) }],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          },
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
        if (!isRecord(call) || typeof call.id !== "string" || call.id === "") {
          s.warnings.push(`ignored tool call without a string id on message ${id} in ${where}`)
          continue
        }
        if (typeof call.name !== "string") {
          s.warnings.push(`ignored tool call ${call.id} without a name in ${where}`)
          continue
        }
        // Live, the root ledger drops a `writeTodos` call's frames once its
        // plan snapshot arrives (a child's frames always flow, and so do the
        // root's when the call produced no plan in this turn).
        if (!nested && call.name === PLAN_TOOL && planFollows(index)) continue
        const toolCallId = call.id
        // Live files a call under the model message that announced it; here
        // that message's id is the one its text above was framed with.
        push(
          s,
          at,
          {
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: call.name,
            parentMessageId: id,
          } as BaseEvent,
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
        // Live, a parked call's tool streamed its running step before the gate
        // parked it; the interrupt kept that display.
        const running = answered.has(toolCallId) ? undefined : parkedStep(input, toolCallId)
        if (running !== undefined) push(s, at, running, owner)
        if (call.name === TASK_TOOL && !answered.has(toolCallId)) {
          // The bridge writes the task's ToolMessage only when the child ends:
          // a running or parked child has a namespace but no message yet. The
          // spec keys the child by the task id in the parent's writes, but
          // `CheckpointForTurns` carries no writes, so the fallback is input:
          // the child's first user message is exactly the call's `input`.
          // Namespaces answered siblings own are already claimed; two open
          // calls with identical input are attached in `children` key order.
          const args = isRecord(call.args) ? call.args : {}
          const name = typeof args.subagent === "string" ? args.subagent : call.name
          const ns = Object.keys(input.children).find(
            (key) =>
              !s.attached.has(key) &&
              typeof args.input === "string" &&
              firstUserText(input.children[key] ?? []) === args.input,
          )
          if (ns === undefined) {
            s.warnings.push(`no child namespace matches open task call ${toolCallId}`)
            continue
          }
          openSubagent(toolCallId, at, name, undefined, ns, input.children[ns])
          // Left open: a parked head's `RUN_FINISHED { interrupt }` pauses it; a busy head keeps it running.
        }
      }
      continue
    }

    if (cls === "ToolMessage") {
      const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : ""
      if (toolCallId === "") {
        s.warnings.push(`ignored ToolMessage ${index} without tool_call_id in ${where}`)
        continue
      }
      const stampValue = stampOf(kwargs, B4_STEP_KEY)
      const step = readPersistedStep(stampValue)
      if (step === undefined) {
        ;(stampValue === undefined ? s.unstamped.missing : s.unstamped.malformed).push(toolCallId)
      }
      const failed = step?.status === "failed" || kwargs.status === "error"
      // Stamp clocks never run ahead of the model checkpoint that announced the call.
      const announced = announcedAt.get(toolCallId) ?? floor
      const startedAt = step ? Math.max(ms(step.startedAt), announced) : at
      const settledAt = step ? Math.max(ms(step.settledAt), startedAt) : at
      if (step && (ms(step.startedAt) < announced || ms(step.settledAt) < startedAt)) {
        s.warnings.push(
          `clamped ${B4_STEP_KEY} clocks on tool call ${toolCallId} to the checkpoint that announced it`,
        )
      }
      const subagentValue = stampOf(kwargs, B4_SUBAGENT_KEY)
      const subagent = readPersistedSubagent(subagentValue)
      if (subagentValue !== undefined && subagent === undefined) {
        s.warnings.push(`ignored malformed ${B4_SUBAGENT_KEY} on tool call ${toolCallId}`)
      }

      if (subagent) {
        const child = input.children[subagent.checkpointNs]
        if (child === undefined) {
          s.warnings.push(
            `no checkpoints for child namespace ${subagent.checkpointNs} of tool call ${toolCallId}`,
          )
        }
        const childLatest = openSubagent(
          toolCallId,
          startedAt,
          subagent.name,
          subagent.description,
          subagent.checkpointNs,
          child,
        )
        // A child checkpoint can postdate the stamped settle; the verifier rejects frames after the finish.
        const finishAt = Math.max(settledAt, childLatest)
        if (subagent.outcome === "failed") {
          const message = subagent.error ?? "The subagent failed."
          push(s, finishAt, {
            type: EventType.SUBAGENT_ERROR,
            subagentRunId: toolCallId,
            message,
          } as BaseEvent)
        } else if (subagent.outcome === "suspended") {
          // Paused at its own gate: the nested turn stays open for the resume.
          const event = {
            type: EventType.SUBAGENT_FINISHED,
            subagentRunId: toolCallId,
            outcome: { type: "suspended" },
          }
          push(s, finishAt, event as BaseEvent)
        } else {
          const event = {
            type: EventType.SUBAGENT_FINISHED,
            subagentRunId: toolCallId,
            result: textOf(kwargs.content),
            outcome: { type: "success" },
          }
          push(s, finishAt, event as BaseEvent)
        }
        s.open.splice(s.open.indexOf(toolCallId), 1)
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
      // Live order: a `completed` (or `denied`) step precedes its result; a
      // `failed` step follows it. A denial is not a failure (#946).
      if (step !== undefined && !failed) {
        push(s, settledAt, stepEvent(step.status === "denied" ? "denied" : "completed"), owner)
      }
      const result = {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId,
        messageId: `tr:${id}`,
        // Live `toResultContent` (outbound.ts) sends the parts a ToolMessage
        // kept for the UI as the content, else the text the model saw.
        content: keptToolParts(kwargs) ?? textOf(kwargs.content),
      }
      push(s, settledAt, result as BaseEvent, owner)
      if (failed) push(s, settledAt, stepEvent("failed"), owner)
    }
    // System/developer envelopes are prompt plumbing.
  }
  flushPlans(Number.POSITIVE_INFINITY)
  closeRun(messages.length, true)
}

/** Shape-check the input: what is not the collection it should be is replaced and named. */
function normalise(input: unknown, warnings: string[]): Normalised | undefined {
  if (!isRecord(input)) {
    warnings.push("input is not an object")
    return undefined
  }
  const threadId = typeof input.threadId === "string" ? input.threadId : ""
  if (threadId === "") warnings.push("threadId is not a string")
  const status =
    input.status === "busy" || input.status === "interrupted" || input.status === "idle"
      ? input.status
      : "idle"
  if (status !== input.status)
    warnings.push(`status ${String(input.status)} is unknown; read as idle`)
  const checkpoints = (value: unknown, name: string): readonly CheckpointForTurns[] => {
    if (!Array.isArray(value)) {
      warnings.push(`${name} is not an array`)
      return []
    }
    return value.filter((cp, index): cp is CheckpointForTurns => {
      if (isRecord(cp) && typeof cp.ts === "string" && isRecord(cp.values)) return true
      const label = isRecord(cp) && typeof cp.id === "string" ? cp.id : `#${index}`
      warnings.push(`ignored checkpoint ${label} in ${name}: not { ts: string, values: object }`)
      return false
    })
  }
  const children: Record<string, readonly CheckpointForTurns[]> = {}
  if (input.children !== undefined) {
    if (isRecord(input.children)) {
      for (const [ns, history] of Object.entries(input.children)) {
        if (Array.isArray(history)) children[ns] = checkpoints(history, `children[${ns}]`)
        else warnings.push(`children[${ns}] is not an array`)
      }
    } else {
      warnings.push("children is not an object")
    }
  }
  let pendingInterrupts: readonly Record<string, unknown>[] = []
  if (input.pendingInterrupts !== undefined) {
    if (Array.isArray(input.pendingInterrupts)) {
      pendingInterrupts = input.pendingInterrupts.filter(isRecord)
    } else {
      warnings.push("pendingInterrupts is not an array")
    }
  }
  return { threadId, status, root: checkpoints(input.root, "root"), children, pendingInterrupts }
}

/** Synthesise the thread's events in stream order; `normalised` is undefined when the input was rejected. */
function synthesise(input: unknown): {
  normalised: Normalised | undefined
  events: BaseEvent[]
  warnings: string[]
} {
  const s: Synth = {
    events: [],
    warnings: [],
    unstamped: { missing: [], malformed: [] },
    attached: new Set(),
    open: [],
    turnFloor: { at: 0, runId: undefined, clamped: new Set() },
  }
  const normalised = normalise(input, s.warnings)
  if (normalised === undefined) return { normalised, events: [], warnings: s.warnings }
  try {
    synthesiseNamespace(s, normalised, normalised.root, undefined, 0)
  } catch (error) {
    s.warnings.push(`synthesis stopped: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const reason of ["missing", "malformed"] as const) {
    const ids = s.unstamped[reason]
    if (ids.length === 1) s.warnings.push(`ignored ${reason} ${B4_STEP_KEY} on tool call ${ids[0]}`)
    else if (ids.length > 1) {
      s.warnings.push(
        `ignored ${reason} ${B4_STEP_KEY} on ${ids.length} tool calls: ${ids.join(", ")}`,
      )
    }
  }
  for (const ns of Object.keys(normalised.children)) {
    if (!s.attached.has(ns)) s.warnings.push(`child namespace ${ns} is not named by any task call`)
  }
  // Events are already in message order; a stable sort by time keeps parallel
  // calls in that order while placing a late-settling result after an earlier one.
  const ordered = s.events.map((e, i) => ({ ...e, i })).sort((a, b) => a.at - b.at || a.i - b.i)
  const events = ordered.map(({ at, event }) => ({ ...event, timestamp: at }) as BaseEvent)
  return { normalised, events, warnings: s.warnings }
}

/**
 * The AG-UI events a live client would have received for this thread,
 * synthesised from its checkpoints (spec §3), each stamped with `timestamp`
 * from the stamped and checkpoint times — a CopilotKit `connect` replay: every
 * root turn opens with `RUN_STARTED` carrying the user's message as `input`,
 * and open subagents close before their turn ends, as live. Stamps that are
 * missing or malformed are ignored and named in `warnings`; never throws.
 */
export function eventsFromState(input: ThreadStateForTurns): EventsFromStateResult {
  const { events, warnings } = synthesise(input)
  return { events, warnings }
}

/**
 * The turns of a thread, rebuilt from its checkpoint chain (spec §3): the
 * events `eventsFromState` synthesises, folded through the unchanged
 * `reduceTurns` with the clock driven by each event's `timestamp`. Stamps that
 * are missing or malformed are ignored and named in `warnings`; the function
 * never throws.
 */
export function turnsFromState(input: ThreadStateForTurns): TurnsFromStateResult {
  const { normalised, events, warnings } = synthesise(input)
  if (normalised === undefined) return { turns: EMPTY_TURNS, warnings }
  let view: TurnsView = { threadId: normalised.threadId, turns: [] }
  try {
    for (const event of events) {
      const at = event.timestamp ?? 0
      view = reduceTurns(view, event, { now: () => at, resuming: false })
    }
  } catch (error) {
    warnings.push(`reduction stopped: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { turns: view, warnings }
}
