import { type ReactElement, useMemo } from "react"
import {
  isSubagentLive,
  type NestedTurn,
  nestedSummaryLine,
  summaryLine,
} from "../../view/activity-format.js"
import { groupSteps, type StepLabelOverrides } from "../../view/labels.js"
import type { TurnView } from "../../view/turns.js"
import { Disclosure, useDisclosure } from "./Disclosure.js"
import { PlanStep } from "./PlanStep.js"
import { ReasoningStep } from "./ReasoningStep.js"
import { Step, type StepRenderers } from "./Step.js"
import { StepGroup } from "./StepGroup.js"
import { SubagentStep } from "./SubagentStep.js"
import { useElapsed } from "./useLive.js"

export interface TurnActivityProps {
  readonly turn: TurnView
  readonly labels?: StepLabelOverrides | undefined
  readonly renderStep?: StepRenderers | undefined
  /** The clock; defaults to `Date.now`. Inject in tests. */
  readonly now?: (() => number) | undefined
  /** Set when this is a subagent's turn: the summary names the subagent instead. */
  readonly nested?: NestedTurn | undefined
}

const defaultNow = () => Date.now()
const isLive = (turn: TurnView) => turn.status === "working" || turn.status === "awaiting"

/** The summary line plus the step list for one turn (spec §3 `TurnActivity`). */
export function TurnActivity({
  turn,
  labels,
  renderStep,
  now = defaultNow,
  nested,
}: TurnActivityProps): ReactElement {
  const live = isLive(turn)
  const sampled = useElapsed(live, now)
  const line = nested
    ? nestedSummaryLine(turn, nested, sampled, labels)
    : summaryLine(turn, sampled, labels)
  // Open while live, folded once settled; a turn settled at mount ("restored")
  // starts folded. No key: a turn that becomes live again is automation's.
  const { open, toggle } = useDisclosure(live, live)
  const grouped = useMemo(() => groupSteps(turn.steps, labels), [turn.steps, labels])
  // A settled subagent's row already says "researcher finished · 5 steps", so
  // its own turn shows the steps straight away instead of repeating that line.
  const settledNested = nested !== undefined && !isSubagentLive(nested)

  const steps = (
    <ol className="b4-turn__steps">
      {grouped.map((item) => {
        switch (item.kind) {
          case "group":
            return (
              <StepGroup
                key={`g:${item.steps[0]?.id}`}
                group={item}
                labels={labels}
                renderStep={renderStep}
                now={now}
              />
            )
          case "tool":
            return (
              <Step key={item.id} step={item} labels={labels} renderStep={renderStep} now={now} />
            )
          case "plan":
            return <PlanStep key={item.id} step={item} live={turn.status === "working"} />
          case "reasoning":
            return <ReasoningStep key={item.id} step={item} />
          default:
            return (
              <SubagentStep
                key={item.id}
                step={item}
                labels={labels}
                renderStep={renderStep}
                now={now}
              />
            )
        }
      })}
    </ol>
  )

  return (
    <section
      className="b4-turn"
      data-state={turn.status}
      {...(open || settledNested ? { "data-expanded": "true" } : {})}
    >
      {settledNested ? (
        steps
      ) : (
        <Disclosure
          className="b4-turn__summary"
          open={open}
          onToggle={toggle}
          summary={
            <>
              <span className="b4-turn__text" {...(line.live ? { "data-live": "true" } : {})}>
                {line.text}
              </span>
              {line.meta ? <span className="b4-turn__time">{line.meta}</span> : null}
            </>
          }
        >
          {steps}
        </Disclosure>
      )}
      {/*
        One live region per turn (spec §5.5). It carries the sentence only, never
        the ticking time, so React touches this text node only when the sentence
        itself changes — a step starting or the turn settling — not every second.
      */}
      <span className="b4-visually-hidden" role="status">
        {line.text}
      </span>
    </section>
  )
}
