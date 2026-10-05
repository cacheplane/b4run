import type {
  ActivitySnapshotEvent,
  BaseEvent,
  Interrupt,
  ReasoningEndEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageStartEvent,
  ReasoningStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  SubagentErrorEvent,
  SubagentFinishedEvent,
  SubagentStartedEvent,
  TextMessageContentEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import type { ToolDisplaySource } from "@b4run/sdk"
import { B4_PLAN_ACTIVITY_TYPE, type B4PlanActivityContent } from "../activities.js"
import type { B4StepEventValue } from "../step.js"
import { readStepEvent } from "./step.js"
import { readPlan } from "./subagent-runs.js"

export type StepStatus = "pending" | "running" | "done" | "failed" | "denied" | "awaiting"
export type TurnStatus = "working" | "awaiting" | "done" | "failed" | "stopped"

/** A source a step cites: the SDK's `ToolDisplaySource`, as `b4.step` carries it. */
export type StepSource = ToolDisplaySource

/** A parked interrupt, as a chat shows it. */
export interface ApprovalView {
  readonly interruptId: string
  /** The interrupt's `reason`: a permission kind (`command`, `tool`, …) or the producer's own word. */
  readonly kind: string
  readonly detail: Readonly<Record<string, unknown>>
  readonly message?: string
  /** The single-use grant to echo back on resume, when the runtime minted one. */
  readonly grant?: string
  /** Whether "Always allow" is an answer here (from the interrupt's `responseSchema`). */
  readonly offersAlways: boolean
}

export interface ToolStep {
  readonly kind: "tool"
  readonly id: string
  readonly name: string
  readonly status: StepStatus
  /** The arguments text streamed so far. */
  readonly args: string
  readonly result?: string
  readonly icon?: string
  /** The server's `b4.step` label, when one arrived; a client falls back on the tool name. */
  readonly label?: string
  readonly sources?: readonly StepSource[]
  readonly startedAt: number
  readonly settledAt?: number
  readonly approval?: ApprovalView
}

export interface PlanStep {
  readonly kind: "plan"
  readonly id: string
  readonly todos: B4PlanActivityContent["todos"]
  readonly startedAt: number
  readonly updatedAt: number
}

export interface ReasoningStep {
  readonly kind: "reasoning"
  /** The span's id (`REASONING_START`), or the message's when no span framed it. */
  readonly id: string
  /**
   * The reasoning message currently streaming inside the span, when it has
   * its own id. Routing only; renderers should ignore it. Overwritten when a
   * span carries a second message.
   */
  readonly messageId?: string
  readonly text: string
  readonly status: "streaming" | "done"
  readonly startedAt: number
  readonly settledAt?: number
}

export interface SubagentStep {
  readonly kind: "subagent"
  /** The `subagentRunId`, which is also the `task` call it replaced. */
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly status: "running" | "paused" | "done" | "failed"
  readonly result?: unknown
  readonly error?: string
  readonly startedAt: number
  readonly settledAt?: number
  /** The child's own turn: its steps, text and approvals. */
  readonly turn: TurnView
}

export type StepView = ToolStep | PlanStep | ReasoningStep | SubagentStep

export interface TurnView {
  /** The run this turn is on; a resumed turn takes the resuming run's id. */
  readonly runId: string
  readonly status: TurnStatus
  readonly startedAt: number
  readonly endedAt?: number
  readonly steps: readonly StepView[]
  /**
   * The assistant's prose for this turn (root) or the child's (nested), as a
   * plain-text summary input — not a transcript. Messages are concatenated;
   * a message that begins after an earlier one (the translator starts a new
   * message at each tool call) is separated from it by one `"\n"`.
   */
  readonly text: string
  /** Interrupts that named no step. */
  readonly approvals: readonly ApprovalView[]
  readonly error?: string
  /** How many steps failed, nested subagents included. */
  readonly failed: number
}

export interface TurnsView {
  readonly threadId?: string
  readonly turns: readonly TurnView[]
}

export interface ReduceTurnsOptions {
  /** The clock; injected so the reducer stays a pure function in tests. */
  readonly now?: () => number
  /** Tools whose frames the view drops entirely (in addition to `writeTodos`, which becomes the plan). */
  readonly hiddenTools?: readonly string[]
  /**
   * Whether a same-thread `RUN_STARTED` continues the last turn. The wire
   * carries no resume signal, so a connector that knows (it just sent a
   * `resume`) should say: `true` glues the run onto the awaiting turn, `false`
   * never glues and appends a turn. Undefined falls back on the heuristic:
   * glue when the last turn is `awaiting`.
   */
  readonly resuming?: boolean
}

export const EMPTY_TURNS: TurnsView = { turns: [] }

const NONE: ReadonlySet<string> = new Set()

/** `Array.prototype.with` for an ES2022 lib. */
function replaceAt<T>(items: readonly T[], index: number, value: T): readonly T[] {
  return [...items.slice(0, index), value, ...items.slice(index + 1)]
}

/** The state with `turns`, or `state` itself when nothing changed (so consumers can compare by identity). */
function withTurns(state: TurnsView, turns: readonly TurnView[]): TurnsView {
  return turns === state.turns ? state : { ...state, turns }
}

function newTurn(runId: string, startedAt: number): TurnView {
  return { runId, status: "working", startedAt, steps: [], text: "", approvals: [], failed: 0 }
}

/** The turn a tagged event belongs to: the subagent's nested turn, else the root turn. */
function updateOwner(
  turns: readonly TurnView[],
  owner: string | undefined,
  update: (turn: TurnView) => TurnView,
): readonly TurnView[] {
  const last = turns.length - 1
  if (last < 0) return turns
  const root = turns[last] as TurnView
  const next = owner === undefined ? update(root) : updateNested(root, owner, update)
  return next === root ? turns : [...turns.slice(0, last), next]
}

/**
 * Update the nested turn of the subagent `owner`, wherever it is, recounting
 * failures on every turn along the path so the root's `failed` reflects a
 * child's failed step as soon as it happens. Unchanged turns keep identity.
 */
function updateNested(
  turn: TurnView,
  owner: string,
  update: (turn: TurnView) => TurnView,
): TurnView {
  return mapSubagent(turn, owner, (step) => {
    const nested = update(step.turn)
    return nested === step.turn ? step : { ...step, turn: nested }
  })
}

/**
 * Update the subagent step with this `subagentRunId`, wherever it is nested
 * (`SUBAGENT_FINISHED`/`ERROR` name only the invocation, not its parent), and
 * recount failures on every turn along the path. Unchanged turns keep identity.
 */
function mapSubagent(
  turn: TurnView,
  id: string,
  update: (step: SubagentStep) => SubagentStep,
): TurnView {
  let changed = false
  const steps = turn.steps.map((step) => {
    if (step.kind !== "subagent") return step
    if (step.id === id) {
      const next = update(step)
      if (next === step) return step
      changed = true
      return next
    }
    const nested = mapSubagent(step.turn, id, update)
    if (nested === step.turn) return step
    changed = true
    return { ...step, turn: nested }
  })
  return changed ? withFailedCount({ ...turn, steps }) : turn
}

/** Mark every subagent on the path to `owner` as `paused` and its nested turn `awaiting`. */
function pauseAncestors(turn: TurnView, owner: string): TurnView {
  const steps = turn.steps.map((step) => {
    if (step.kind !== "subagent") return step
    if (step.id === owner || containsOwner(step.turn, owner)) {
      return {
        ...step,
        status: "paused" as const,
        turn: { ...pauseAncestors(step.turn, owner), status: "awaiting" as const },
      }
    }
    return step
  })
  return { ...turn, steps }
}

function containsOwner(turn: TurnView, owner: string): boolean {
  return turn.steps.some(
    (step) => step.kind === "subagent" && (step.id === owner || containsOwner(step.turn, owner)),
  )
}

/**
 * The turn as the run that answers its interrupts continues it: the user
 * decided, so the approvals are gone, gated steps run again (the resumed run
 * re-presents the call under the same id and its result annotates the step),
 * and paused subagents and their turns work again. History stays.
 *
 * The wire carries no resume signal. Gluing is backed by the server's policy
 * that an awaiting thread answers only a resume (`409 resume_required`), so
 * the next run on it is the resume — unless this view is stale (the approval
 * was answered elsewhere), when the next turn is glued onto the old one; a
 * connector that knows better passes `resuming: false`.
 *
 * A deny: the gated call is never re-executed, so no result arrives and the
 * step settles as `failed` at `RUN_FINISHED`. A B4 permission deny instead
 * returns the denial text as the call's result, so that step reads `done`
 * (a dedicated label for it is a server-side follow-up).
 */
function resumeTurn(turn: TurnView, runId: string): TurnView {
  const steps = turn.steps.map((step): StepView => {
    switch (step.kind) {
      case "tool": {
        if (step.status !== "awaiting") return step
        const { approval: _, ...rest } = step
        return { ...rest, status: "running" }
      }
      case "subagent":
        return step.status === "paused"
          ? { ...step, status: "running", turn: resumeTurn(step.turn, step.turn.runId) }
          : step
      default:
        return step
    }
  })
  return { ...turn, runId, status: "working", steps, approvals: [] }
}

function mapStep(turn: TurnView, id: string, update: (step: ToolStep) => ToolStep): TurnView {
  let changed = false
  const steps = turn.steps.map((step) => {
    if (step.kind !== "tool" || step.id !== id) return step
    const next = update(step)
    if (next === step) return step
    changed = true
    return next
  })
  return changed ? { ...turn, steps } : turn
}

function mapReasoning(
  turn: TurnView,
  match: (step: ReasoningStep) => boolean,
  update: (step: ReasoningStep) => ReasoningStep,
): TurnView {
  let changed = false
  const steps = turn.steps.map((step) => {
    if (step.kind !== "reasoning" || !match(step)) return step
    const next = update(step)
    if (next === step) return step
    changed = true
    return next
  })
  return changed ? { ...turn, steps } : turn
}

/** The newest reasoning span still streaming, for content whose id no span claims. */
function newestOpenReasoning(turn: TurnView): ReasoningStep | undefined {
  for (let index = turn.steps.length - 1; index >= 0; index--) {
    const step = turn.steps[index]
    if (step?.kind === "reasoning" && step.status === "streaming") return step
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The approval an interrupt shows, or undefined for an entry that is not one (`[null]`, a string, no id). */
function approvalOf(value: unknown): ApprovalView | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined
  const interrupt = value as unknown as Interrupt
  const metadata = isRecord(interrupt.metadata) ? interrupt.metadata : {}
  const detail = metadata.detail
  const schema = isRecord(interrupt.responseSchema) ? interrupt.responseSchema : undefined
  return {
    interruptId: interrupt.id,
    kind: typeof interrupt.reason === "string" ? interrupt.reason : "interrupt",
    detail:
      typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : {},
    ...(typeof interrupt.message === "string" ? { message: interrupt.message } : {}),
    ...(typeof metadata.grant === "string" ? { grant: metadata.grant } : {}),
    offersAlways: Array.isArray(schema?.enum) && schema.enum.includes("always"),
  }
}

/**
 * Running or pending work never settles on its own: the turn ending settles
 * it as failed — except the calls in `keepOpen`, which the client itself still
 * owes a result for (`pendingToolCallIds`) and which stay as they are. An open
 * subagent's nested turn ends failed too, carrying `error` when there is one.
 */
function settleOpen(
  turn: TurnView,
  at: number,
  keepOpen: ReadonlySet<string>,
  error?: string,
): TurnView {
  const steps = turn.steps.map((step): StepView => {
    switch (step.kind) {
      case "tool":
        return (step.status === "running" || step.status === "pending") && !keepOpen.has(step.id)
          ? { ...step, status: "failed", settledAt: at }
          : step
      case "reasoning":
        return step.status === "streaming" ? { ...step, status: "done", settledAt: at } : step
      case "subagent":
        return step.status === "running"
          ? {
              ...step,
              status: "failed",
              settledAt: at,
              ...(error !== undefined ? { error } : {}),
              turn: failTurn(step.turn, at, keepOpen, error),
            }
          : step
      default:
        return step
    }
  })
  return { ...turn, steps, failed: countFailed(steps) }
}

/** A turn ended by failure: its open work settled, status failed, with the error when known. */
function failTurn(
  turn: TurnView,
  at: number,
  keepOpen: ReadonlySet<string>,
  error?: string,
): TurnView {
  return {
    ...settleOpen(turn, at, keepOpen, error),
    status: "failed",
    endedAt: at,
    ...(error !== undefined ? { error } : {}),
  }
}

function countFailed(steps: readonly StepView[]): number {
  let failed = 0
  for (const step of steps) {
    if (step.kind === "tool" && step.status === "failed") failed++
    if (step.kind === "subagent") failed += (step.status === "failed" ? 1 : 0) + step.turn.failed
  }
  return failed
}

function withFailedCount(turn: TurnView): TurnView {
  const failed = countFailed(turn.steps)
  return failed === turn.failed ? turn : { ...turn, failed }
}

/**
 * Fold one AG-UI event into the turns of a thread. Pure given `now`: the same
 * events in the same order yield a deep-equal view, live, replayed or
 * restored. Root events land on the last turn; an event tagged
 * `subagentRunId` lands on that subagent's nested turn, however deep. A run
 * that answers the last turn's interrupts continues that turn; a `RUN_STARTED`
 * for a run already shown (a replay from the start) resets that turn in place.
 *
 * A call's `b4.step` and `TOOL_CALL_RESULT` may arrive in either order: a
 * `completed` or `failed` step never reverts to running, a later result never
 * erases a done label, and re-applying a settled call's `completed` step and
 * identical result changes nothing. An event that changes nothing returns
 * `state` itself.
 */
export function reduceTurns(
  state: TurnsView,
  event: BaseEvent,
  options: ReduceTurnsOptions = {},
): TurnsView {
  if (typeof event !== "object" || event === null) return state
  const now = options.now ?? Date.now
  const rawOwner = (event as { subagentRunId?: unknown }).subagentRunId
  const owner = typeof rawOwner === "string" ? rawOwner : undefined

  switch (event.type) {
    case EventType.RUN_STARTED: {
      const { threadId, runId } = event as { threadId?: unknown; runId?: unknown }
      if (typeof threadId !== "string" || typeof runId !== "string") return state
      if (threadId !== state.threadId) return { threadId, turns: [newTurn(runId, now())] }
      // A run already shown is a replay from its start: it re-delivers that
      // run and everything after it, so the view restarts there. A reattach
      // to a resumed turn's runId rebuilds only the post-resume half.
      const replayed = state.turns.findIndex((turn) => turn.runId === runId)
      if (replayed !== -1) {
        return { threadId, turns: [...state.turns.slice(0, replayed), newTurn(runId, now())] }
      }
      const last = state.turns.at(-1)
      const resuming = options.resuming ?? last?.status === "awaiting"
      if (last !== undefined && resuming) {
        return {
          threadId,
          turns: replaceAt(state.turns, state.turns.length - 1, resumeTurn(last, runId)),
        }
      }
      return { threadId, turns: [...state.turns, newTurn(runId, now())] }
    }
    case EventType.RUN_FINISHED: {
      const { outcome } = event as RunFinishedEvent
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, undefined, (turn) => {
          if (outcome?.type === "interrupt") {
            let next: TurnView = { ...turn, status: "awaiting" }
            const interrupts: readonly unknown[] = Array.isArray(outcome.interrupts)
              ? outcome.interrupts
              : []
            for (const interrupt of interrupts) next = attachInterrupt(next, interrupt)
            return next
          }
          const pending = outcome?.type === "success" ? outcome.pendingToolCallIds : undefined
          const keepOpen = Array.isArray(pending)
            ? new Set(pending.filter((id): id is string => typeof id === "string"))
            : NONE
          return {
            ...settleOpen(turn, at, keepOpen),
            status: outcome?.type === "cancelled" ? "stopped" : "done",
            endedAt: at,
          }
        }),
      )
    }
    case EventType.RUN_ERROR: {
      const { message } = event as RunErrorEvent
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, undefined, (turn) => failTurn(turn, at, NONE, message)),
      )
    }
    case EventType.SUBAGENT_STARTED: {
      const started = event as SubagentStartedEvent
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, started.parentSubagentRunId, (turn) => {
          const existing = turn.steps.find(
            (step): step is SubagentStep =>
              step.kind === "subagent" && step.id === started.subagentRunId,
          )
          const step: SubagentStep = {
            kind: "subagent",
            id: started.subagentRunId,
            name: started.name,
            ...(started.description !== undefined ? { description: started.description } : {}),
            status: "running",
            startedAt: existing?.startedAt ?? at,
            // A continued invocation keeps what the earlier run showed.
            turn: existing?.turn ?? newTurn(started.subagentRunId, at),
          }
          if (existing !== undefined) {
            return { ...turn, steps: turn.steps.map((s) => (s === existing ? step : s)) }
          }
          // Replace the `task` call that started it, in place.
          const taskCallId = started.parentToolCallId ?? started.subagentRunId
          const index = turn.steps.findIndex((s) => s.kind === "tool" && s.id === taskCallId)
          const steps = index === -1 ? [...turn.steps, step] : replaceAt(turn.steps, index, step)
          return { ...turn, steps }
        }),
      )
    }
    case EventType.SUBAGENT_FINISHED: {
      const finished = event as SubagentFinishedEvent
      const at = now()
      const suspended = finished.outcome?.type === "suspended"
      return withTurns(
        state,
        updateOwner(state.turns, undefined, (root) =>
          mapSubagent(root, finished.subagentRunId, (step) => ({
            ...step,
            status: suspended ? "paused" : "done",
            ...(finished.result !== undefined ? { result: finished.result } : {}),
            ...(suspended
              ? {}
              : {
                  settledAt: at,
                  turn: { ...settleOpen(step.turn, at, NONE), status: "done", endedAt: at },
                }),
          })),
        ),
      )
    }
    case EventType.SUBAGENT_ERROR: {
      const failed = event as SubagentErrorEvent
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, undefined, (root) =>
          mapSubagent(root, failed.subagentRunId, (step) => ({
            ...step,
            status: "failed",
            error: failed.message,
            settledAt: at,
            turn: failTurn(step.turn, at, NONE, failed.message),
          })),
        ),
      )
    }
    default:
      break
  }

  const step = readStepEvent(event)
  if (step !== undefined) {
    return withTurns(
      state,
      updateOwner(state.turns, owner, (turn) => applyStep(turn, step, now())),
    )
  }

  switch (event.type) {
    case EventType.TOOL_CALL_START: {
      const { toolCallId, toolCallName } = event as ToolCallStartEvent
      if (options.hiddenTools?.includes(toolCallName)) return state
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) => {
          if (toolCallName === "writeTodos") {
            // The plan presents this call; keep its place with an empty plan
            // until the snapshot arrives. For the root agent the ledger
            // suppresses these frames when a `b4.plan` snapshot correlates
            // with the call, so they usually reach the view only for a child's
            // plan — or when the root call produced no snapshot (it threw).
            // Then the view shows an empty plan and no failure: the call's
            // result and `failed` step find no tool step to annotate.
            if (turn.steps.some((s) => s.kind === "plan")) return turn
            const plan: PlanStep = {
              kind: "plan",
              id: `plan:${turn.runId}`,
              todos: [],
              startedAt: at,
              updatedAt: at,
            }
            return { ...turn, steps: [...turn.steps, plan] }
          }
          if (turn.steps.some((s) => s.kind === "tool" && s.id === toolCallId)) {
            // The resumed run re-presents a gated call under the same id and
            // streams its arguments again: start them over, keep the rest.
            return mapStep(turn, toolCallId, (s) => (s.args === "" ? s : { ...s, args: "" }))
          }
          const tool: ToolStep = {
            kind: "tool",
            id: toolCallId,
            name: toolCallName,
            status: "pending",
            args: "",
            startedAt: at,
          }
          return { ...turn, steps: [...turn.steps, tool] }
        }),
      )
    }
    case EventType.TOOL_CALL_ARGS: {
      const { toolCallId, delta } = event as ToolCallArgsEvent
      if (typeof delta !== "string" || delta === "") return state
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) =>
          mapStep(turn, toolCallId, (s) => ({ ...s, args: s.args + delta })),
        ),
      )
    }
    case EventType.TOOL_CALL_END: {
      const { toolCallId } = event as ToolCallEndEvent
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) =>
          mapStep(turn, toolCallId, (s) =>
            s.status === "pending" ? { ...s, status: "running" } : s,
          ),
        ),
      )
    }
    case EventType.TOOL_CALL_RESULT: {
      const { toolCallId, content } = event as ToolCallResultEvent
      // A string, or the text parts of a parts array; anything else reads as empty.
      const result =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((part) =>
                  isRecord(part) && part.type === "text" && typeof part.text === "string"
                    ? part.text
                    : "",
                )
                .join("")
            : ""
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) =>
          mapStep(turn, toolCallId, (s) => {
            if (
              s.result === result &&
              (s.status === "done" || s.status === "failed" || s.status === "denied")
            ) {
              return s
            }
            // A `failed` or `denied` step already said how this ended; a
            // `completed` one already settled it, so its time stands.
            return s.status === "failed" || s.status === "denied"
              ? { ...s, result }
              : { ...s, result, status: "done", settledAt: s.settledAt ?? at }
          }),
        ),
      )
    }
    case EventType.ACTIVITY_SNAPSHOT: {
      const { activityType, content, messageId } = event as ActivitySnapshotEvent
      if (activityType !== B4_PLAN_ACTIVITY_TYPE) return state
      const todos = readPlan(content)
      if (todos === undefined) return state
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) => {
          const index = turn.steps.findIndex((s) => s.kind === "plan")
          if (index === -1) {
            const plan: PlanStep = {
              kind: "plan",
              id: messageId,
              todos,
              startedAt: at,
              updatedAt: at,
            }
            return { ...turn, steps: [...turn.steps, plan] }
          }
          const existing = turn.steps[index] as PlanStep
          return {
            ...turn,
            steps: replaceAt(turn.steps, index, {
              ...existing,
              id: messageId,
              todos,
              updatedAt: at,
            }),
          }
        }),
      )
    }
    case EventType.REASONING_START: {
      const { messageId } = event as ReasoningStartEvent
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) => openReasoning(turn, messageId, at)),
      )
    }
    case EventType.REASONING_MESSAGE_START: {
      // A message inside an open span streams into that span; a message no
      // span framed (another producer's shape) is a span of its own.
      const { messageId } = event as ReasoningMessageStartEvent
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) => {
          if (turn.steps.some((s) => s.kind === "reasoning" && s.id === messageId)) return turn
          const span = newestOpenReasoning(turn)
          if (span === undefined) return openReasoning(turn, messageId, at)
          return mapReasoning(
            turn,
            (s) => s === span,
            (s) => (s.messageId === messageId ? s : { ...s, messageId }),
          )
        }),
      )
    }
    case EventType.REASONING_MESSAGE_CONTENT: {
      const { messageId, delta } = event as ReasoningMessageContentEvent
      if (typeof delta !== "string" || delta === "") return state
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) => {
          // Content belongs to the span (or message) with its id; only an
          // unknown id falls back on this owner's newest open span.
          const known = turn.steps.some(
            (s) => s.kind === "reasoning" && (s.id === messageId || s.messageId === messageId),
          )
          const target = known ? undefined : newestOpenReasoning(turn)
          if (!known && target === undefined) return turn
          return mapReasoning(
            turn,
            (s) => (known ? s.id === messageId || s.messageId === messageId : s === target),
            (s) => ({ ...s, text: s.text + delta }),
          )
        }),
      )
    }
    case EventType.REASONING_END: {
      // Closes the span by its id, or by its current message's id when a
      // producer ends the span before (or instead of) the message: tolerant
      // on purpose, since either shape leaves nothing more to stream.
      const { messageId } = event as ReasoningEndEvent
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) =>
          mapReasoning(
            turn,
            (s) => s.status === "streaming" && (s.id === messageId || s.messageId === messageId),
            (s) => ({ ...s, status: "done", settledAt: at }),
          ),
        ),
      )
    }
    case EventType.TEXT_MESSAGE_START: {
      // A new message after an earlier one starts on its own line; the
      // translator opens a new message at each tool call, so this is the
      // break a step put in the prose. Messages interleaved by id (which the
      // translator never does) read as "A\nBA2": accepted, this is a summary.
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) =>
          turn.text === "" || turn.text.endsWith("\n") ? turn : { ...turn, text: `${turn.text}\n` },
        ),
      )
    }
    case EventType.TEXT_MESSAGE_CONTENT: {
      const { delta } = event as TextMessageContentEvent
      if (typeof delta !== "string" || delta === "") return state
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) => ({ ...turn, text: turn.text + delta })),
      )
    }
    default:
      return state
  }
}

function openReasoning(turn: TurnView, id: string, at: number): TurnView {
  if (turn.steps.some((s) => s.kind === "reasoning" && s.id === id)) return turn
  const reasoning: ReasoningStep = {
    kind: "reasoning",
    id,
    text: "",
    status: "streaming",
    startedAt: at,
  }
  return { ...turn, steps: [...turn.steps, reasoning] }
}

/**
 * Merge a `b4.step` into its tool step. `running` only lifts a pending step;
 * `completed` and `denied` settle it (the result, before or after, keeps that
 * time); `failed` wins over everything. Labels, icons and sources always take
 * the newest value, whatever the status — except that `denied` drops the
 * running label and sources it does not replace: a call a gate blocked never
 * did what "Searching the corpus…" says, and the server sends no done label
 * for it. A denial is not a failure: the policy or the user answered, nothing
 * threw, so it never counts toward `turn.failed`. A step for a call this turn
 * never saw framed (e.g. frames suppressed upstream) has nothing to annotate.
 * A step that changes nothing keeps the tool step's identity.
 */
function applyStep(turn: TurnView, step: B4StepEventValue, at: number): TurnView {
  const next = mapStep(turn, step.toolCallId, (s) => {
    const status: StepStatus =
      step.status === "failed"
        ? "failed"
        : step.status === "completed" || step.status === "denied"
          ? s.status === "failed"
            ? s.status
            : step.status === "denied"
              ? "denied"
              : "done"
          : s.status === "pending"
            ? "running"
            : s.status
    const settles = status === "done" || status === "failed" || status === "denied"
    const { label: _label, sources: _sources, ...bare } = s
    const base: ToolStep = step.status === "denied" ? bare : s
    const patched: ToolStep = {
      ...base,
      ...(step.icon !== undefined ? { icon: step.icon } : {}),
      ...(step.label !== undefined ? { label: step.label } : {}),
      ...(step.sources !== undefined ? { sources: step.sources } : {}),
      status,
      ...(settles ? { settledAt: s.settledAt ?? at } : {}),
    }
    return sameToolStep(s, patched) ? s : patched
  })
  return step.status === "failed" ? withFailedCount(next) : next
}

function sameToolStep(a: ToolStep, b: ToolStep): boolean {
  return (
    a.status === b.status &&
    a.settledAt === b.settledAt &&
    a.icon === b.icon &&
    a.label === b.label &&
    a.sources === b.sources
  )
}

/** Put an interrupt on the step it names (pausing the subagents above it), or on the turn. */
function attachInterrupt(turn: TurnView, entry: unknown): TurnView {
  const approval = approvalOf(entry)
  if (approval === undefined) return turn
  const interrupt = entry as Interrupt
  const owner = typeof interrupt.subagentRunId === "string" ? interrupt.subagentRunId : undefined
  const toolCallId = typeof interrupt.toolCallId === "string" ? interrupt.toolCallId : undefined
  const place = (target: TurnView): TurnView => {
    if (
      toolCallId !== undefined &&
      target.steps.some((s) => s.kind === "tool" && s.id === toolCallId)
    ) {
      return mapStep(target, toolCallId, (s) => ({ ...s, status: "awaiting", approval }))
    }
    return { ...target, approvals: [...target.approvals, approval] }
  }
  if (owner === undefined) return place(turn)
  const placed = updateNested(turn, owner, (nested) => ({ ...place(nested), status: "awaiting" }))
  return placed === turn ? place(turn) : pauseAncestors(placed, owner)
}
