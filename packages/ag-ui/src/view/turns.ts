import type {
  ActivitySnapshotEvent,
  BaseEvent,
  CustomEvent,
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
import {
  B4_STEP_EVENT_NAME,
  B4_STEP_METADATA_KEY,
  type B4MediaPart,
  type B4StepSource,
  type B4ToolStep,
  type B4ToolStepUpdate,
  isContentPart,
  isToolDisplayIcon,
  readToolStepUpdate,
  type ToolDisplaySource,
} from "@b4run/sdk"
import { B4_PLAN_ACTIVITY_TYPE, type B4PlanActivityContent } from "../activities.js"
import { readPlan } from "./plan.js"
import { isSettledStatus, mergeIntoToolStep, sameToolStep } from "./tool-steps.js"

/**
 * A tool step's status. `cancelled` is a call the run stopped before it
 * finished (a cancelled run, or an interrupt that parked other calls); like
 * `denied`, it is not a failure.
 */
export type StepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "denied"
  | "cancelled"
  | "awaiting"
export type TurnStatus = "working" | "awaiting" | "done" | "failed" | "stopped"

/**
 * A source a step cites: the SDK's `ToolDisplaySource`, plus the `b4.step`
 * contract's source fields (`id`, `kind`, `cited`, …) when the step carried them.
 */
export type StepSource = ToolDisplaySource & Partial<Omit<B4StepSource, "title" | "href">>

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
  /** The result's text: a string result, or the text parts of a part list joined. */
  readonly result?: string
  /**
   * The result's non-text parts (an image a chart tool rendered), in order;
   * present only when the result carried any, live or restored.
   */
  readonly parts?: readonly B4MediaPart[]
  readonly icon?: string
  /** The server's `b4.step` label, when one arrived; a client falls back on the tool name. */
  readonly label?: string
  readonly sources?: readonly StepSource[]
  /** `provider` when the model provider ran the call (a built-in web search); absent for the agent's own tools. */
  readonly toolKind?: B4ToolStep["kind"]
  /** The provider built-in the call is (`web_search`, …), from `b4.step`. */
  readonly builtin?: string
  /** The model provider that ran a `provider` call (`openai`, …), from `b4.step`. */
  readonly provider?: string
  /** The queries the call ran, from `b4.step`. */
  readonly queries?: readonly string[]
  /** The producer's error for a failed step, when it sent one. */
  readonly error?: NonNullable<B4ToolStep["error"]>
  /** The approval decision that settled the call, from `b4.step`. */
  readonly decision?: B4ToolStep["decision"]
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
  /**
   * When the span ended. Absent while streaming, and for a span that started
   * and ended at the same instant: a restored thread replays each span at its
   * message's checkpoint time, so its length is unknown, not zero.
   */
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
  /**
   * Internal: `b4.step` updates for calls this turn has not seen start, keyed
   * by tool call id and applied in order at the call's `TOOL_CALL_START`.
   * Renderers should ignore it.
   */
  readonly pendingSteps?: Readonly<Record<string, readonly B4ToolStepUpdate[]>>
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
 * A call the interrupt cancelled stays cancelled here; when the resumed run
 * presents it again, `TOOL_CALL_START` reopens it.
 *
 * A deny: the gated call is never re-executed, so no result arrives; a
 * successful `RUN_FINISHED` settles no open call (the `b4.step` contract), so
 * the step stays `running` unless a `denied` step names it. A B4 permission
 * deny instead returns the denial text as the call's result, so that step
 * reads `done` (a dedicated label for it is a server-side follow-up).
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

/** How a turn's end settles its open tool calls; `undefined` leaves them open. */
type ToolOutcome = "failed" | "cancelled" | undefined

/**
 * An open (pending or running) tool call settled as `outcome`, the way the
 * contract's `settleOpenSteps` does: the running label and sources go, since
 * the call never did what they said.
 */
function settleTool(step: ToolStep, outcome: "failed" | "cancelled", at: number): ToolStep {
  const { label: _label, sources: _sources, ...rest } = step
  return { ...rest, status: outcome, settledAt: at }
}

const isOpenTool = (step: ToolStep, keepOpen: ReadonlySet<string>): boolean =>
  (step.status === "running" || step.status === "pending") && !keepOpen.has(step.id)

/**
 * The turn ending settles its open work: open tool calls as `tools` (`failed`
 * at a run error, `cancelled` at a cancelled run; a successful run leaves
 * them, per the `b4.step` contract) — except the calls in `keepOpen`, which
 * the client itself still owes a result for (`pendingToolCallIds`) and which
 * stay as they are. Streaming reasoning ends. An open subagent's nested turn
 * ends failed, its open calls settled as `tools` (`failed` when the run left
 * them open), carrying `error` when there is one.
 */
function settleOpen(
  turn: TurnView,
  at: number,
  keepOpen: ReadonlySet<string>,
  tools: ToolOutcome,
  error?: string,
): TurnView {
  const steps = turn.steps.map((step): StepView => {
    switch (step.kind) {
      case "tool":
        return tools !== undefined && isOpenTool(step, keepOpen)
          ? settleTool(step, tools, at)
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
              turn: failTurn(step.turn, at, keepOpen, error, tools ?? "failed"),
            }
          : step
      default:
        return step
    }
  })
  // A step still held for a call that never started has nothing left to annotate.
  const { pendingSteps: _pendingSteps, ...ended } = turn
  return { ...ended, steps, failed: countFailed(steps) }
}

/**
 * Settles every open tool call as `cancelled`, nested subagent turns included,
 * except the calls in `keepOpen`; nothing else changes. Unchanged turns keep
 * their identity.
 */
function cancelOpenTools(turn: TurnView, at: number, keepOpen: ReadonlySet<string>): TurnView {
  let changed = false
  const steps = turn.steps.map((step): StepView => {
    if (step.kind === "tool" && isOpenTool(step, keepOpen)) {
      changed = true
      return settleTool(step, "cancelled", at)
    }
    if (step.kind !== "subagent") return step
    const nested = cancelOpenTools(step.turn, at, keepOpen)
    if (nested === step.turn) return step
    changed = true
    return { ...step, turn: nested }
  })
  return changed ? { ...turn, steps } : turn
}

/** A turn ended by failure: its open work settled, status failed, with the error when known. */
function failTurn(
  turn: TurnView,
  at: number,
  keepOpen: ReadonlySet<string>,
  error?: string,
  tools: "failed" | "cancelled" = "failed",
): TurnView {
  return {
    ...settleOpen(turn, at, keepOpen, tools, error),
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
 * Tool steps follow the `b4.step` contract (`@b4run/sdk`): a step arrives as
 * `b4.step` metadata on `TOOL_CALL_START`, `_END` and `_RESULT` (the result's
 * beats the call's) or as a `CUSTOM` `b4.step` event, v1 or legacy, and merges
 * by `mergeToolStep`; a step for a call not yet started is held until its
 * `TOOL_CALL_START` (never across runs). A result ends a call still open,
 * dropping its running label: failed when the result carries `error`, else
 * done. A `TOOL_CALL_START` reopens a cancelled call. A run error fails
 * the open calls, a cancelled run cancels them, and an interrupt cancels all
 * but the calls it parks; a successful run settles none.
 *
 * A call's `b4.step` and `TOOL_CALL_RESULT` may arrive in either order: a
 * `completed` or `failed` step never reverts to running, a later result never
 * erases a done label (unless it carries a top-level `error`, which fails the
 * call even after a `completed` step), and re-applying a settled call's
 * `completed` step and
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
            // The parked calls stay open for the resume; every other open
            // call stopped with the run (the `b4.step` contract).
            let next: TurnView = { ...turn, status: "awaiting" }
            const interrupts: readonly unknown[] = Array.isArray(outcome.interrupts)
              ? outcome.interrupts
              : []
            for (const interrupt of interrupts) next = attachInterrupt(next, interrupt)
            // Steps held for calls this run never started do not cross into the resume.
            return dropHeldSteps(cancelOpenTools(next, at, parkedCalls(interrupts, outcome)))
          }
          if (outcome?.type === "cancelled") {
            return { ...settleOpen(turn, at, NONE, "cancelled"), status: "stopped", endedAt: at }
          }
          // A successful run settles no open call: a call still running after
          // it (a background job) keeps running, per the `b4.step` contract.
          const pending = outcome?.type === "success" ? outcome.pendingToolCallIds : undefined
          return {
            ...settleOpen(turn, at, stringSet(pending), undefined),
            status: "done",
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
              ? { turn: dropHeldSteps(step.turn) }
              : {
                  settledAt: at,
                  turn: {
                    ...settleOpen(step.turn, at, NONE, "failed"),
                    status: "done",
                    endedAt: at,
                  },
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

  switch (event.type) {
    case EventType.CUSTOM: {
      const { name, value } = event as CustomEvent
      if (name !== B4_STEP_EVENT_NAME) return state
      // A v1 step or a legacy `B4StepEventValue`; `kind` stays unstated when
      // the value states none, so it never overwrites a stored `provider`.
      const update = readToolStepUpdate(value)
      const id = update?.toolCallId
      if (update === undefined || id === undefined) return state
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) =>
          turn.steps.some((s) => s.kind === "tool" && s.id === id)
            ? applyStep(turn, id, update, "call", now())
            : holdStep(turn, id, update),
        ),
      )
    }
    case EventType.TOOL_CALL_START: {
      const { toolCallId, toolCallName } = event as ToolCallStartEvent
      if (options.hiddenTools?.includes(toolCallName)) return state
      const update = stepMetadata(event, toolCallId)
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
          const tool: ToolStep = {
            kind: "tool",
            id: toolCallId,
            name: toolCallName,
            status: "pending",
            args: "",
            startedAt: at,
          }
          // The resumed run re-presents a gated call under the same id and
          // streams its arguments again: start them over, keep the rest. A
          // call the interrupt cancelled runs again, so it reopens.
          const framed = turn.steps.some((s) => s.kind === "tool" && s.id === toolCallId)
            ? mapStep(turn, toolCallId, (s) =>
                s.status === "cancelled"
                  ? {
                      ...reopenTool(s),
                      args:
                        (event as ToolCallStartEvent).parentMessageId === undefined ? s.args : "",
                    }
                  : (event as ToolCallStartEvent).parentMessageId === undefined
                    ? s
                    : s.args === ""
                      ? s
                      : { ...s, args: "" },
              )
            : { ...turn, steps: [...turn.steps, tool] }
          // Steps that arrived before the call apply now, then its own metadata.
          const started = releaseHeldSteps(framed, toolCallId, at)
          return update === undefined ? started : applyStep(started, toolCallId, update, "call", at)
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
      const update = stepMetadata(event, toolCallId)
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) => {
          const ended = mapStep(turn, toolCallId, (s) =>
            s.status === "pending" ? { ...s, status: "running" } : s,
          )
          return update === undefined ? ended : applyStep(ended, toolCallId, update, "call", now())
        }),
      )
    }
    case EventType.TOOL_CALL_RESULT: {
      const { toolCallId, content } = event as ToolCallResultEvent
      // A string, or the text parts of a parts array; anything else reads as empty.
      const list: readonly unknown[] = Array.isArray(content) ? content : []
      const result =
        typeof content === "string"
          ? content
          : list
              .map((part) =>
                isRecord(part) && part.type === "text" && typeof part.text === "string"
                  ? part.text
                  : "",
              )
              .join("")
      const media = list.filter(
        (part): part is B4MediaPart => isContentPart(part) && part.type !== "text",
      )
      // The result message's own step beats the call's (`"message"`).
      const update = stepMetadata(event, toolCallId)
      const { error } = event as { error?: unknown }
      const failure = typeof error === "string" && error !== "" ? error : undefined
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) =>
          withFailedCount(
            mapStep(turn, toolCallId, (s) => {
              const sameParts =
                media.length === 0
                  ? s.parts === undefined
                  : JSON.stringify(s.parts) === JSON.stringify(media)
              const { parts: _parts, ...rest } = s
              const withResult: ToolStep = {
                ...rest,
                result,
                ...(media.length > 0 ? { parts: media } : {}),
              }
              const merged =
                update === undefined
                  ? withResult
                  : mergeIntoToolStep(withResult, update, "message", at)
              // A result flagged as an error fails the call whatever its step
              // said (failed wins). Otherwise it ends a call still open as
              // done, and the running label no longer says what happened. A
              // settled step already said how it ended; its time stands.
              const settled: ToolStep =
                failure !== undefined
                  ? mergeIntoToolStep(
                      merged,
                      { v: 1, status: "failed", error: { message: failure } },
                      "message",
                      at,
                    )
                  : isSettledStatus(merged.status)
                    ? merged
                    : endOpenTool(merged, at)
              return s.result === result && sameParts && sameToolStep(s, settled) ? s : settled
            }),
          ),
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
      // on purpose, since either shape leaves nothing more to stream. A span
      // that ends at the instant it started has no known length (a restored
      // thread stamps the whole span with its message's checkpoint time), so
      // it keeps no `settledAt` and never claims "<1s".
      const { messageId } = event as ReasoningEndEvent
      const at = now()
      return withTurns(
        state,
        updateOwner(state.turns, owner, (turn) =>
          mapReasoning(
            turn,
            (s) => s.status === "streaming" && (s.id === messageId || s.messageId === messageId),
            (s) =>
              at === s.startedAt
                ? { ...s, status: "done" }
                : { ...s, status: "done", settledAt: at },
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
 * Merge a `b4.step` update into the tool step `id` by the contract's rules
 * (`mergeIntoToolStep`), recounting failures. A denial or a cancellation is
 * not a failure: the policy, the user or the run answered, nothing threw, so
 * neither counts toward `turn.failed`. A step that changes nothing keeps the
 * turn's identity.
 */
function applyStep(
  turn: TurnView,
  id: string,
  update: B4ToolStepUpdate,
  source: "call" | "message",
  at: number,
): TurnView {
  const next = mapStep(turn, id, (s) => mergeIntoToolStep(s, update, source, at))
  return next === turn ? turn : withFailedCount(next)
}

/** An open call its result ended without an error: `done`, dropping the running label and keeping the sources. */
function endOpenTool(step: ToolStep, at: number): ToolStep {
  const { label: _label, ...rest } = step
  return { ...rest, status: "done", settledAt: step.settledAt ?? at }
}

/** A cancelled call presented again (the resume runs it): back to the frames, no label, no settle time. */
function reopenTool(step: ToolStep): ToolStep {
  const { label: _label, settledAt: _settledAt, ...rest } = step
  return { ...rest, status: "pending", args: "" }
}

/** The turn without held steps, nested subagent turns included; unchanged turns keep identity. */
function dropHeldSteps(turn: TurnView): TurnView {
  let changed = false
  const steps = turn.steps.map((step): StepView => {
    if (step.kind !== "subagent") return step
    const nested = dropHeldSteps(step.turn)
    if (nested === step.turn) return step
    changed = true
    return { ...step, turn: nested }
  })
  if (!changed && turn.pendingSteps === undefined) return turn
  const { pendingSteps: _pendingSteps, ...rest } = turn
  return { ...rest, steps }
}

/** Holds a `b4.step` for a call this turn has not seen start, until its `TOOL_CALL_START`. */
function holdStep(turn: TurnView, id: string, update: B4ToolStepUpdate): TurnView {
  const held = turn.pendingSteps ?? {}
  const earlier = Object.hasOwn(held, id) ? (held[id] ?? []) : []
  return { ...turn, pendingSteps: { ...held, [id]: [...earlier, update] } }
}

/** Applies, in order, the steps held for `id`, and forgets them. */
function releaseHeldSteps(turn: TurnView, id: string, at: number): TurnView {
  const held = turn.pendingSteps
  if (held === undefined || !Object.hasOwn(held, id)) return turn
  const { [id]: updates = [], ...rest } = held
  const { pendingSteps: _pendingSteps, ...bare } = turn
  const base: TurnView = Object.keys(rest).length > 0 ? { ...bare, pendingSteps: rest } : bare
  return updates.reduce((next, update) => applyStep(next, id, update, "call", at), base)
}

/** The `b4.step` a tool-call frame or result carries in its metadata, if any. */
function stepMetadata(event: BaseEvent, toolCallId: string): B4ToolStepUpdate | undefined {
  const { metadata } = event as { metadata?: unknown }
  return isRecord(metadata)
    ? readToolStepUpdate(metadata[B4_STEP_METADATA_KEY], toolCallId)
    : undefined
}

/** The string entries of a list off the wire, as a set. */
function stringSet(value: unknown): ReadonlySet<string> {
  return Array.isArray(value)
    ? new Set(value.filter((id): id is string => typeof id === "string"))
    : NONE
}

/**
 * The calls an interrupt parks, which stay open for the resume: the ones its
 * interrupts name, plus any `pendingToolCallIds` the outcome lists.
 */
function parkedCalls(interrupts: readonly unknown[], outcome: object): ReadonlySet<string> {
  const named = interrupts.flatMap((entry) =>
    isRecord(entry) && typeof entry.toolCallId === "string" ? [entry.toolCallId] : [],
  )
  const pending = (outcome as { pendingToolCallIds?: unknown }).pendingToolCallIds
  return new Set([...named, ...stringSet(pending)])
}

/** Put an interrupt on the step it names (pausing the subagents above it), or on the turn. */
function attachInterrupt(turn: TurnView, entry: unknown): TurnView {
  const approval = approvalOf(entry)
  if (approval === undefined) return turn
  const interrupt = entry as Interrupt
  const owner = typeof interrupt.subagentRunId === "string" ? interrupt.subagentRunId : undefined
  const toolCallId = typeof interrupt.toolCallId === "string" ? interrupt.toolCallId : undefined
  const metadata = isRecord(interrupt.metadata) ? interrupt.metadata : {}
  const display = isRecord(metadata.step) ? metadata.step : {}
  const parkedDisplay = {
    ...(isToolDisplayIcon(display.icon) ? { icon: display.icon } : {}),
    ...(typeof display.label === "string" && display.label !== "" ? { label: display.label } : {}),
  }
  const place = (target: TurnView): TurnView => {
    if (
      toolCallId !== undefined &&
      target.steps.some((s) => s.kind === "tool" && s.id === toolCallId)
    ) {
      return mapStep(target, toolCallId, (s) => ({
        ...s,
        ...parkedDisplay,
        status: "awaiting",
        approval,
      }))
    }
    return { ...target, approvals: [...target.approvals, approval] }
  }
  if (owner === undefined) return place(turn)
  const placed = updateNested(turn, owner, (nested) => ({ ...place(nested), status: "awaiting" }))
  return placed === turn ? place(turn) : pauseAncestors(placed, owner)
}
