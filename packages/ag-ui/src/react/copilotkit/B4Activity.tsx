import { useAgent, useInterrupt, useRenderTool } from "@copilotkit/react-core/v2"
import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from "react"
import { approvalFromInterrupt, approvalPrompt } from "../../view/activity-lookup.js"
import type { StepLabelOverrides } from "../../view/labels.js"
import type { TurnsView } from "../../view/turns.js"
import { ApprovalCard, type ApprovalDecision } from "../activity/ApprovalCard.js"
import type { StepRenderers } from "../activity/Step.js"
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
          const approval = approvalFromInterrupt(interrupt)
          const { agent: agentName, label } = approvalPrompt(turns, interrupt, labels)
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
