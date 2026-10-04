import type {
  ActivitySnapshotEvent,
  BaseEvent,
  Interrupt,
  ReasoningEndEvent,
  ReasoningMessageContentEvent,
  ReasoningStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
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
import { B4_PLAN_ACTIVITY_TYPE, type B4PlanActivityContent } from "../activities.js"
import type { B4StepEventValue } from "../step.js"
import { readStepEvent } from "./step.js"

export type StepStatus = "pending" | "running" | "done" | "failed" | "awaiting"
export type TurnStatus = "working" | "awaiting" | "done" | "failed" | "stopped"

export interface StepSource {
  readonly title: string
  readonly href?: string
}

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
  readonly id: string
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
  readonly runId: string
  readonly status: TurnStatus
  readonly startedAt: number
  readonly endedAt?: number
  readonly steps: readonly StepView[]
  /** The assistant's prose for this turn (root) or the child's (nested). */
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
}

export const EMPTY_TURNS: TurnsView = { turns: [] }

type Attributed = BaseEvent & { readonly subagentRunId?: string }

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

function updateNested(
  turn: TurnView,
  owner: string,
  update: (turn: TurnView) => TurnView,
): TurnView {
  let changed = false
  const steps = turn.steps.map((step) => {
    if (step.kind !== "subagent") return step
    if (step.id === owner) {
      changed = true
      return { ...step, turn: update(step.turn) }
    }
    const nested = updateNested(step.turn, owner, update)
    if (nested === step.turn) return step
    changed = true
    return { ...step, turn: nested }
  })
  return changed ? { ...turn, steps } : turn
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
      changed = true
      return update(step)
    }
    const nested = mapSubagent(step.turn, id, update)
    if (nested === step.turn) return step
    changed = true
    return { ...step, turn: nested }
  })
  return changed ? withFailedCount({ ...turn, steps }) : turn
}

/** Also mark every subagent on the path to `owner` as `paused`. */
function pauseAncestors(turn: TurnView, owner: string): TurnView {
  const steps = turn.steps.map((step) => {
    if (step.kind !== "subagent") return step
    if (step.id === owner || containsOwner(step.turn, owner)) {
      return { ...step, status: "paused" as const, turn: pauseAncestors(step.turn, owner) }
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

function readTodos(content: unknown): B4PlanActivityContent["todos"] | undefined {
  if (typeof content !== "object" || content === null) return undefined
  const todos = (content as { todos?: unknown }).todos
  return Array.isArray(todos) ? (todos as B4PlanActivityContent["todos"]) : undefined
}

function approvalOf(interrupt: Interrupt): ApprovalView {
  const metadata = (interrupt.metadata ?? {}) as Record<string, unknown>
  const detail = metadata.detail
  const schema = interrupt.responseSchema as { enum?: unknown } | undefined
  return {
    interruptId: interrupt.id,
    kind: interrupt.reason,
    detail:
      typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : {},
    ...(interrupt.message !== undefined ? { message: interrupt.message } : {}),
    ...(typeof metadata.grant === "string" ? { grant: metadata.grant } : {}),
    offersAlways: Array.isArray(schema?.enum) && schema.enum.includes("always"),
  }
}

/**
 * Running or pending work never settles on its own: the turn ending settles
 * it as failed — except the calls in `keepOpen`, which the client itself still
 * owes a result for (`pendingToolCallIds`) and which stay as they are.
 */
function settleOpen(turn: TurnView, at: number, keepOpen: ReadonlySet<string>): TurnView {
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
          ? { ...step, status: "failed", settledAt: at, turn: settleOpen(step.turn, at, keepOpen) }
          : step
      default:
        return step
    }
  })
  return { ...turn, steps, failed: countFailed(steps) }
}

const NONE: ReadonlySet<string> = new Set()

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
 * `subagentRunId` lands on that subagent's nested turn, however deep.
 *
 * A call's `b4.step` and `TOOL_CALL_RESULT` may arrive in either order and
 * neither downgrades the other: a `completed` or `failed` step never reverts
 * to running, a later result never erases a done label, and re-applying a
 * settled call's events changes nothing.
 */
export function reduceTurns(
  state: TurnsView,
  event: BaseEvent,
  options: ReduceTurnsOptions = {},
): TurnsView {
  const now = options.now ?? Date.now
  const owner = (event as Attributed).subagentRunId

  switch (event.type) {
    case EventType.RUN_STARTED: {
      const { threadId, runId } = event as RunStartedEvent
      const turn = newTurn(runId, now())
      return threadId === state.threadId
        ? { threadId, turns: [...state.turns, turn] }
        : { threadId, turns: [turn] }
    }
    case EventType.RUN_FINISHED: {
      const { outcome } = event as RunFinishedEvent
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, undefined, (turn) => {
          if (outcome?.type === "interrupt") {
            let next: TurnView = { ...turn, status: "awaiting" }
            for (const interrupt of outcome.interrupts) next = attachInterrupt(next, interrupt)
            return next
          }
          const keepOpen =
            outcome?.type === "success" && outcome.pendingToolCallIds !== undefined
              ? new Set(outcome.pendingToolCallIds)
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
        updateOwner(state.turns, undefined, (turn) => ({
          ...settleOpen(turn, at, NONE),
          status: "failed",
          endedAt: at,
          error: message,
        })),
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
            turn: {
              ...settleOpen(step.turn, at, NONE),
              status: "failed",
              endedAt: at,
              error: failed.message,
            },
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
            // until the snapshot arrives (root frames are usually suppressed
            // upstream, so this mostly matters for a child's plan).
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
          if (turn.steps.some((s) => s.kind === "tool" && s.id === toolCallId)) return turn
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
      const result =
        typeof content === "string"
          ? content
          : content.map((part) => (part.type === "text" ? part.text : "")).join("")
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) =>
          mapStep(turn, toolCallId, (s) => {
            if (s.result === result && (s.status === "done" || s.status === "failed")) return s
            // A `failed` step already said how this ended; a `completed` one
            // already settled it, so its time stands.
            return s.status === "failed"
              ? { ...s, result }
              : { ...s, result, status: "done", settledAt: s.settledAt ?? at }
          }),
        ),
      )
    }
    case EventType.ACTIVITY_SNAPSHOT: {
      const { activityType, content, messageId } = event as ActivitySnapshotEvent
      if (activityType !== B4_PLAN_ACTIVITY_TYPE) return state
      const todos = readTodos(content)
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
        updateOwner(state.turns, owner, (turn) => {
          const reasoning: ReasoningStep = {
            kind: "reasoning",
            id: messageId,
            text: "",
            status: "streaming",
            startedAt: at,
          }
          return { ...turn, steps: [...turn.steps, reasoning] }
        }),
      )
    }
    case EventType.REASONING_MESSAGE_CONTENT: {
      const { delta } = event as ReasoningMessageContentEvent
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) => {
          // Content belongs to the newest open reasoning span of this owner.
          for (let index = turn.steps.length - 1; index >= 0; index--) {
            const s = turn.steps[index]
            if (s?.kind === "reasoning" && s.status === "streaming") {
              return {
                ...turn,
                steps: replaceAt(turn.steps, index, { ...s, text: s.text + delta }),
              }
            }
          }
          return turn
        }),
      )
    }
    case EventType.REASONING_END: {
      const { messageId } = event as ReasoningEndEvent
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) => ({
          ...turn,
          steps: turn.steps.map((s) =>
            s.kind === "reasoning" && s.id === messageId && s.status === "streaming"
              ? { ...s, status: "done", settledAt: at }
              : s,
          ),
        })),
      )
    }
    case EventType.TEXT_MESSAGE_CONTENT: {
      const { delta } = event as TextMessageContentEvent
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) => ({ ...turn, text: turn.text + delta })),
      )
    }
    default:
      return state
  }
}

/**
 * Merge a `b4.step` into its tool step. `running` only lifts a pending step;
 * `completed` settles it (the result, before or after, keeps that time);
 * `failed` wins over everything. Labels, icons and sources always take the
 * newest value, whatever the status. A step for a call this turn never saw
 * framed (e.g. frames suppressed upstream) has nothing to annotate.
 */
function applyStep(turn: TurnView, step: B4StepEventValue, at: number): TurnView {
  const patch = {
    ...(step.icon !== undefined ? { icon: step.icon } : {}),
    ...(step.label !== undefined ? { label: step.label } : {}),
    ...(step.sources !== undefined ? { sources: step.sources } : {}),
  }
  const next = mapStep(turn, step.toolCallId, (s) => {
    switch (step.status) {
      case "running":
        return { ...s, ...patch, status: s.status === "pending" ? "running" : s.status }
      case "completed":
        return s.status === "failed"
          ? { ...s, ...patch }
          : { ...s, ...patch, status: "done", settledAt: s.settledAt ?? at }
      case "failed":
        return { ...s, ...patch, status: "failed", settledAt: s.settledAt ?? at }
    }
  })
  return step.status === "failed" ? withFailedCount(next) : next
}

/** Put an interrupt on the step it names (pausing the subagents above it), or on the turn. */
function attachInterrupt(turn: TurnView, interrupt: Interrupt): TurnView {
  const approval = approvalOf(interrupt)
  const owner = interrupt.subagentRunId
  const place = (target: TurnView): TurnView => {
    const toolCallId = interrupt.toolCallId
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
