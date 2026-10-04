import { type ReactElement, useState } from "react"
import type { StepLabelOverrides } from "../../view/labels.js"
import type { SubagentStep as SubagentStepView } from "../../view/turns.js"
import { Disclosure } from "./Disclosure.js"
import { countSteps } from "./format.js"
import { StepIcon } from "./icons.js"
import { StatusText } from "./StatusText.js"
import type { StepRenderers } from "./Step.js"
// Circular with TurnActivity.tsx: each references the other only while
// rendering, never at module top level, so the ESM cycle resolves either way.
import { TurnActivity } from "./TurnActivity.js"

export interface SubagentStepProps {
  readonly step: SubagentStepView
  readonly labels?: StepLabelOverrides | undefined
  readonly renderStep?: StepRenderers | undefined
  readonly now: () => number
}

/** A paused subagent is waiting on an approval, so its row reads as awaiting. */
const STATE = { running: "running", paused: "awaiting", done: "done", failed: "failed" } as const

/** "Asked researcher to …" with the child's own activity nested (spec §3 `SubagentStep`). */
export function SubagentStep({ step, labels, renderStep, now }: SubagentStepProps): ReactElement {
  const live = step.status === "running" || step.status === "paused"
  const autoOpen = live || step.status === "failed"
  const [expanded, setExpanded] = useState(autoOpen)
  const steps = countSteps(step.turn)
  const text = live ? (
    <>
      Asked <b>{step.name}</b> to {step.description ?? "help"}
    </>
  ) : step.status === "failed" ? (
    `${step.name} failed`
  ) : (
    `${step.name} finished`
  )
  const meta =
    step.status === "failed"
      ? step.error
        ? `· ${step.error}`
        : ""
      : live
        ? ""
        : `· ${steps} step${steps === 1 ? "" : "s"}`
  return (
    <li
      className="b4-step"
      data-state={STATE[step.status]}
      data-kind="subagent"
      {...(expanded ? { "data-expanded": "true" } : {})}
    >
      <Disclosure
        className="b4-step__line"
        autoOpen={autoOpen}
        live={live}
        onOpenChange={setExpanded}
        panelClassName="b4-step__children"
        summary={
          <>
            <StepIcon name={step.status === "failed" ? "alert" : "agent"} />
            <span className="b4-step__text">{text}</span>
            <StatusText>{meta}</StatusText>
          </>
        }
      >
        <TurnActivity
          turn={step.turn}
          labels={labels}
          renderStep={renderStep}
          now={now}
          nested={{ name: step.name, status: step.status }}
        />
      </Disclosure>
    </li>
  )
}
