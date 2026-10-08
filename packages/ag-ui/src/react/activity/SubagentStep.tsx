import type { ReactElement } from "react"
import {
  isSubagentLive,
  subagentMeta,
  subagentRowState,
  subagentSettledText,
} from "../../view/activity-format.js"
import type { StepLabelOverrides } from "../../view/labels.js"
import type { SubagentStep as SubagentStepView } from "../../view/turns.js"
import { Disclosure, useDisclosure } from "./Disclosure.js"
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

/**
 * "Asked researcher", its description as a muted line beneath, with the
 * child's own activity nested (spec §3 `SubagentStep`). Descriptions are
 * third-person summaries ("Briefs the weather …"), so they are never spliced
 * into the sentence. A settled child that took no steps has nothing to open,
 * so its line is a plain `span` rather than a button.
 */
export function SubagentStep({ step, labels, renderStep, now }: SubagentStepProps): ReactElement {
  const live = isSubagentLive(step)
  const empty = !live && step.turn.steps.length === 0
  const autoOpen = !empty && (live || step.status === "failed")
  const { open, toggle } = useDisclosure(autoOpen, live, step.startedAt)
  const text = live ? (
    <>
      Asked <b>{step.name}</b>
      {step.description ? <span className="b4-step__note">{step.description}</span> : null}
    </>
  ) : (
    subagentSettledText(step)
  )
  const summary = (
    <>
      <StepIcon name={step.status === "failed" ? "alert" : "agent"} />
      <span className="b4-step__text">{text}</span>
      <StatusText>{subagentMeta(step)}</StatusText>
    </>
  )
  if (empty) {
    return (
      <li className="b4-step" data-state={subagentRowState(step.status)} data-kind="subagent">
        <span className="b4-step__line b4-step__line--static">{summary}</span>
      </li>
    )
  }
  return (
    <li
      className="b4-step"
      data-state={subagentRowState(step.status)}
      data-kind="subagent"
      {...(open ? { "data-expanded": "true" } : {})}
    >
      <Disclosure
        className="b4-step__line"
        open={open}
        onToggle={toggle}
        panelClassName="b4-step__children"
        summary={summary}
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
