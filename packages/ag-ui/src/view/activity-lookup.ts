import type { Interrupt } from "@ag-ui/core"
import { type StepLabelOverrides, stepLabel } from "./labels.js"
import type { ApprovalView, StepView, ToolStep, TurnsView, TurnView } from "./turns.js"

/**
 * The lookups every chat connector needs between a transcript, its turns and
 * its parked interrupts: which turn a message belongs to, and what an approval
 * card says. Framework-free, so the React and Angular connectors (and any
 * host with its own chat) share one implementation.
 */

/** Who an approval card names when no subagent owns the gated call. */
const ROOT_AGENT = "The agent"

/** The turn that owns any of these tool call ids, searching nested turns. */
export function turnForToolCalls(turns: TurnsView, ids: readonly string[]): TurnView | undefined {
  if (ids.length === 0) return undefined
  const owns = (steps: readonly StepView[]): boolean =>
    steps.some(
      (s) =>
        (s.kind === "tool" && ids.includes(s.id)) ||
        (s.kind === "subagent" && (ids.includes(s.id) || owns(s.turn.steps))),
    )
  return turns.turns.find((turn) => owns(turn.steps))
}

/**
 * The parts of a transcript message the turn lookup reads. AG-UI's `Message`
 * fits, and so does any host message type with an id, a role and the
 * assistant's tool calls.
 */
export interface TranscriptMessage {
  readonly id: string
  readonly role: string
  readonly toolCalls?: ReadonlyArray<{ readonly id: string }> | undefined
}

/** The turn an assistant message belongs to, and whether it is that turn's first assistant message. */
export interface MessageTurn {
  readonly turn: TurnView
  readonly first: boolean
}

const isSubagent = (message: TranscriptMessage): boolean =>
  typeof (message as { subagentRunId?: unknown }).subagentRunId === "string"

/**
 * The turn the assistant message `messageId` belongs to. A turn is the run of
 * messages after a `user` message; subagent messages are skipped (their text
 * lives inside the nested turn). The turn is found by the tool calls of every
 * assistant message in that run (`turnForToolCalls`), else by position counted
 * from the end of the thread — the newest run of messages is the newest turn —
 * skipping a trailing `user` message whose run has not started yet.
 *
 * `first` marks the run's first assistant message: a chat with one activity
 * slot per message renders the turn's activity there, and nowhere else, so
 * each turn shows one activity block. Undefined for a message that is not an
 * assistant message of `messages`, or when no turn matches.
 */
export function turnForMessage(
  turns: TurnsView,
  messages: readonly TranscriptMessage[],
  messageId: string,
): MessageTurn | undefined {
  const runs: TranscriptMessage[][] = []
  let current: TranscriptMessage[] | undefined
  for (const message of messages) {
    if (isSubagent(message)) continue
    if (message.role === "user") {
      current = []
      runs.push(current)
    } else if (message.role === "assistant") {
      if (current === undefined) {
        current = []
        runs.push(current)
      }
      current.push(message)
    }
  }
  const index = runs.findIndex((run) => run.some((m) => m.id === messageId))
  const run = runs[index]
  if (run === undefined) return undefined
  const first = run[0]?.id === messageId
  const ids = run.flatMap((m) => m.toolCalls?.map((call) => call.id) ?? [])
  const byIds = turnForToolCalls(turns, ids)
  if (byIds !== undefined) return { turn: byIds, first }
  // A trailing user message's run has not started (no turn yet) while the
  // runs before it each have one: count from the run before it.
  let last = runs.length - 1
  if (runs.length > turns.turns.length && runs[last]?.length === 0) last -= 1
  const turn = turns.turns[turns.turns.length - 1 - (last - index)]
  return turn !== undefined && last >= index ? { turn, first } : undefined
}

/**
 * A parked interrupt as an approval card shows it: its kind (`metadata.kind`,
 * else the interrupt's `reason`), detail, message, the grant to echo, and
 * whether "Always allow" is offered (the response schema's `enum`).
 */
export function approvalFromInterrupt(interrupt: Interrupt): ApprovalView {
  const metadata = (interrupt.metadata ?? {}) as Record<string, unknown>
  const detail = (
    typeof metadata.detail === "object" && metadata.detail !== null ? metadata.detail : {}
  ) as Record<string, unknown>
  const schema = interrupt.responseSchema as { enum?: unknown } | undefined
  const message = interrupt.message ?? metadata.message
  return {
    interruptId: interrupt.id,
    kind: typeof metadata.kind === "string" ? metadata.kind : interrupt.reason,
    detail,
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof metadata.grant === "string" ? { grant: metadata.grant } : {}),
    offersAlways: Array.isArray(schema?.enum) && schema.enum.includes("always"),
  }
}

/** The step a parked interrupt gates, and the agent it sits in, at any depth. */
function locate(
  turns: readonly TurnView[],
  toolCallId: string | undefined,
  agentName = ROOT_AGENT,
): { step?: ToolStep; agent: string } {
  if (toolCallId === undefined) return { agent: agentName }
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (step.kind === "tool" && step.id === toolCallId) return { step, agent: agentName }
      if (step.kind === "subagent") {
        const found = locate([step.turn], toolCallId, step.name)
        if (found.step) return found
      }
    }
  }
  return { agent: agentName }
}

/** The subagent that owns `subagentRunId`, at any depth. */
function subagentName(turns: readonly TurnView[], subagentRunId: string): string | undefined {
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (step.kind !== "subagent") continue
      if (step.id === subagentRunId) return step.name
      const nested = subagentName([step.turn], subagentRunId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

const lowerFirst = (s: string): string => (s.length > 0 ? `${s[0]?.toLowerCase()}${s.slice(1)}` : s)

/**
 * What follows "wants to" on an approval card: the step's running label (an
 * app override's, else the server's `display.running`), lower-cased. With
 * neither — a restored parked call carries no running label — `stepLabel`
 * falls back on a progressive "Using X…", which cannot follow "wants to", so
 * the card says "use X" instead.
 */
export function approvalLabel(step: ToolStep, labels: StepLabelOverrides | undefined): string {
  const label = stepLabel({ ...step, status: "running" }, labels)
  return step.label === undefined && label === `Using ${step.name}…`
    ? `use ${step.name}`
    : lowerFirst(label)
}

/** Who an approval card names and what they want: "{agent} wants to {label}". */
export interface ApprovalPrompt {
  readonly agent: string
  readonly label: string
}

/**
 * The card's "{agent} wants to {label}" for a parked interrupt: the gated
 * step's running label (`approvalLabel`) and the subagent it sits in, at any
 * depth, else "The agent" and "continue" for an interrupt that names no step.
 */
export function approvalPrompt(
  turns: TurnsView,
  interrupt: Pick<Interrupt, "toolCallId" | "subagentRunId" | "metadata">,
  labels: StepLabelOverrides | undefined,
): ApprovalPrompt {
  const metadata = (interrupt.metadata ?? {}) as Record<string, unknown>
  const subagentRunId =
    interrupt.subagentRunId ??
    (typeof metadata.subagentRunId === "string" ? metadata.subagentRunId : undefined)
  const located = locate(turns.turns, interrupt.toolCallId)
  if (located.step !== undefined) {
    return { agent: located.agent, label: approvalLabel(located.step, labels) }
  }
  const agent =
    (subagentRunId !== undefined ? subagentName(turns.turns, subagentRunId) : undefined) ??
    ROOT_AGENT
  return { agent, label: "continue" }
}

/** One approval card to show: the parked interrupt and its prompt. */
export interface PendingApproval extends ApprovalPrompt {
  readonly approval: ApprovalView
}

/**
 * The approval cards an awaiting thread shows, read from the turns alone (for
 * a host whose chat framework has no interrupt API): every awaiting step's
 * approval in the last turn and its paused subagents, in step order, then the
 * interrupts that named no step. Empty unless the last turn is awaiting.
 */
export function pendingApprovals(
  turns: TurnsView,
  labels: StepLabelOverrides | undefined,
): readonly PendingApproval[] {
  const last = turns.turns.at(-1)
  if (last === undefined || last.status !== "awaiting") return []
  const out: PendingApproval[] = []
  const collect = (turn: TurnView, agent: string): void => {
    for (const step of turn.steps) {
      if (step.kind === "tool" && step.status === "awaiting" && step.approval !== undefined) {
        out.push({ approval: step.approval, agent, label: approvalLabel(step, labels) })
      } else if (step.kind === "subagent") {
        collect(step.turn, step.name)
      }
    }
    for (const approval of turn.approvals) out.push({ approval, agent, label: "continue" })
  }
  collect(last, ROOT_AGENT)
  return out
}
