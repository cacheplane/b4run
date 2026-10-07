import type { Interrupt } from "@ag-ui/client"
import { useAgent, useInterrupt, useRenderTool } from "@copilotkit/react-core/v2"
import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from "react"
import { ApprovalCard, type ApprovalDecision } from "../react/activity/ApprovalCard.js"
import type { StepRenderers } from "../react/activity/Step.js"
import { type StepLabelOverrides, stepLabel } from "../view/labels.js"
import type { ApprovalView, StepView, ToolStep, TurnsView, TurnView } from "../view/turns.js"
import { useB4Turns } from "./useB4Turns.js"

export interface B4ActivityContextValue {
  readonly turns: TurnsView
  readonly labels: StepLabelOverrides | undefined
  readonly renderStep: StepRenderers | undefined
  readonly now: () => number
}

const Context = createContext<B4ActivityContextValue | undefined>(undefined)

/**
 * The turns, labels, `renderStep` and clock `B4Activity` provides, for host UI
 * outside the chat (a map, a sheet); throws outside `B4Activity`.
 */
export function useB4ActivityContext(): B4ActivityContextValue {
  const value = useContext(Context)
  if (value === undefined) throw new Error("useB4ActivityContext must be used inside <B4Activity>")
  return value
}

export interface B4ActivityProps {
  /** The CopilotKit agent to follow; defaults to the configured chat agent. */
  readonly agentId?: string | undefined
  /** Per-tool label overrides (`stepLabel`); client wording wins over the server's. */
  readonly labels?: StepLabelOverrides | undefined
  /** Tools whose frames the view drops entirely. */
  readonly hiddenTools?: readonly string[] | undefined
  /** Per-tool step renderers (`Step`'s `renderStep`). */
  readonly renderStep?: StepRenderers | undefined
  /** The clock; defaults to `Date.now`. Inject in tests. */
  readonly now?: (() => number) | undefined
  /**
   * `true` (default): CopilotKit places the approval cards inside
   * `<CopilotChat>`, after the messages. `false`: the cards render here,
   * after `children`, for a host with its own transcript and no `<CopilotChat>`.
   */
  readonly renderInChat?: boolean | undefined
  readonly children?: ReactNode
}

const ROOT_AGENT = "The agent"

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

function approvalOf(interrupt: Interrupt): ApprovalView {
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

const lowerFirst = (s: string): string => (s.length > 0 ? `${s[0]?.toLowerCase()}${s.slice(1)}` : s)

/**
 * What follows "wants to" on an approval card: the step's running label (an
 * app override's, else the server's `display.running`), lower-cased. With
 * neither — a restored parked call carries no running label — `stepLabel`
 * falls back on a progressive "Using X…", which cannot follow "wants to", so
 * the card says "use X" instead.
 */
function approvalLabel(step: ToolStep, labels: StepLabelOverrides | undefined): string {
  const label = stepLabel({ ...step, status: "running" }, labels)
  return step.label === undefined && label === `Using ${step.name}…`
    ? `use ${step.name}`
    : lowerFirst(label)
}

/**
 * Drives a stock `<CopilotChat>` with B4.run's activity kit (spec §6.2): hides
 * CopilotKit's generic tool rows, renders one `ApprovalCard` per parked
 * interrupt, and provides the thread's turns to `useB4ChatSlots`.
 *
 * CopilotKit has ONE interrupt slot: another `useInterrupt` with the default
 * `renderInChat` anywhere in the same app replaces B4's cards. Wildcard
 * `useRenderTool({ name: "*" })` registrations are last-wins and never
 * removed, so do not also call `useDefaultRenderTool()`.
 *
 * Grants: CopilotKit's `resolve(payload)` carries only the decision, so the
 * interrupt's `grant` (`ApprovalView.grant`, kept for the view) is never
 * echoed on resume. The connector supports `approvals.grants: "off"` today;
 * with `"optional"` or `"required"` the server answers the resume with 409.
 *
 * The card's title is "<agent> wants to <label>", where the label is the gated
 * step's running label with its first letter lower-cased, verbatim. Tool
 * authors: phrase `display.running` as an infinitive ("run a command") so the
 * card reads "The agent wants to run a command"; a progressive label
 * ("Running node x") reads "wants to running node x". A step with no running
 * label at all (a restored parked call) reads "wants to use <tool>".
 */
export function B4Activity({
  agentId,
  labels,
  hiddenTools,
  renderStep,
  now = Date.now,
  renderInChat = true,
  children,
}: B4ActivityProps): ReactElement {
  const { agent } = useAgent(agentId !== undefined ? { agentId } : {})
  const { turns, markResuming, clearResuming } = useB4Turns(agent, { now, hiddenTools })
  useRenderTool({ name: "*", render: () => null, ...(agentId !== undefined ? { agentId } : {}) }, [
    agentId,
  ])
  // CopilotKit memoises the interrupt element on `[pending, result, resolve,
  // cancel]`: the cards are built from the turns and labels current when the
  // interrupt arrived (the same event that parks the turn), and a later
  // `labels` change does not re-render an open card.
  const cards = useInterrupt<never, boolean>({
    ...(agentId !== undefined ? { agentId } : {}),
    renderInChat,
    render: ({ interrupts, resolve, cancel }) => (
      <>
        {interrupts.map((interrupt) => {
          const approval = approvalOf(interrupt)
          const metadata = (interrupt.metadata ?? {}) as Record<string, unknown>
          const subagentRunId =
            interrupt.subagentRunId ??
            (typeof metadata.subagentRunId === "string" ? metadata.subagentRunId : undefined)
          const located = locate(turns.turns, interrupt.toolCallId)
          const agentName =
            located.step !== undefined
              ? located.agent
              : ((subagentRunId !== undefined
                  ? subagentName(turns.turns, subagentRunId)
                  : undefined) ?? ROOT_AGENT)
          const label = located.step
            ? approvalLabel(located.step, labels)
            : "continue"
          const onDecide = async (decision: ApprovalDecision) => {
            markResuming()
            try {
              if (decision === "deny") await cancel(interrupt.id)
              else await resolve(decision, interrupt.id)
            } catch (cause) {
              // No resume went out; the next RUN_STARTED must not glue onto this turn.
              clearResuming()
              throw cause
            }
          }
          return (
            <ApprovalCard
              key={interrupt.id}
              approval={approval}
              agent={agentName}
              label={label}
              onDecide={onDecide}
            />
          )
        })}
      </>
    ),
  })
  const value = useMemo<B4ActivityContextValue>(
    () => ({ turns, labels, renderStep, now }),
    [turns, labels, renderStep, now],
  )
  return (
    <Context.Provider value={value}>
      {children}
      {renderInChat ? null : (cards ?? null)}
    </Context.Provider>
  )
}

/** The turn that owns any of these tool call ids, searching nested turns. */
export function turnForToolCalls(turns: TurnsView, ids: readonly string[]): TurnView | undefined {
  const owns = (steps: readonly StepView[]): boolean =>
    steps.some(
      (s) =>
        (s.kind === "tool" && ids.includes(s.id)) ||
        (s.kind === "subagent" && (ids.includes(s.id) || owns(s.turn.steps))),
    )
  return turns.turns.find((turn) => owns(turn.steps))
}
