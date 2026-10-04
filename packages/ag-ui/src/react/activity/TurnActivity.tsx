import { type ReactElement, useMemo, useState } from "react"
import { groupSteps, type StepLabelOverrides } from "../../view/labels.js"
import type { TurnView } from "../../view/turns.js"
import { Disclosure } from "./Disclosure.js"
import { countSteps, type SummaryLine, summaryLine } from "./format.js"
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
  readonly nested?:
    | { readonly name: string; readonly status: "running" | "paused" | "done" | "failed" }
    | undefined
}

const defaultNow = () => Date.now()
const isLive = (turn: TurnView) => turn.status === "working" || turn.status === "awaiting"

/**
 * The summary of a subagent's own turn. While the subagent runs it reads like
 * any turn (spec §3.1: the active step's label, the elapsed tick); once it
 * pauses or settles it names the subagent: "researcher · paused",
 * "researcher finished · 5 steps", "researcher failed · boom".
 */
function nestedSummary(
  turn: TurnView,
  nested: NonNullable<TurnActivityProps["nested"]>,
  sampled: number,
): SummaryLine {
  const n = countSteps(turn)
  const steps = `· ${n} step${n === 1 ? "" : "s"}`
  switch (nested.status) {
    case "running":
      return summaryLine(turn, sampled)
    case "paused":
      return { text: `${nested.name} · paused`, meta: "", live: false }
    case "failed":
      return {
        text: `${nested.name} failed`,
        meta: turn.error ? `· ${turn.error}` : steps,
        live: false,
      }
    default:
      return { text: `${nested.name} finished`, meta: steps, live: false }
  }
}

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
  const line = nested ? nestedSummary(turn, nested, sampled) : summaryLine(turn, sampled)
  // Mirrors `autoOpen`, so the first (static) render already carries
  // `data-expanded`; a turn settled at mount ("restored") starts folded.
  const [expanded, setExpanded] = useState(live)
  const grouped = useMemo(() => groupSteps(turn.steps, labels), [turn.steps, labels])

  return (
    <section
      className="b4-turn"
      data-state={turn.status}
      {...(expanded ? { "data-expanded": "true" } : {})}
    >
      <Disclosure
        className="b4-turn__summary"
        autoOpen={live}
        live={live}
        onOpenChange={setExpanded}
        summary={
          <>
            <span className="b4-turn__text" {...(line.live ? { "data-live": "true" } : {})}>
              {line.text}
            </span>
            {line.meta ? <span className="b4-turn__time">{line.meta}</span> : null}
          </>
        }
      >
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
                  <Step
                    key={item.id}
                    step={item}
                    labels={labels}
                    renderStep={renderStep}
                    now={now}
                  />
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
      </Disclosure>
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
