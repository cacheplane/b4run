import type { ReactElement } from "react"
import type { StepGroup as StepGroupView, StepLabelOverrides } from "../../view/labels.js"
import { Disclosure, useDisclosure } from "./Disclosure.js"
import { StepIcon } from "./icons.js"
import { StatusText } from "./StatusText.js"
import { Step, type StepRenderers } from "./Step.js"

export interface StepGroupProps {
  readonly group: StepGroupView
  readonly labels?: StepLabelOverrides | undefined
  readonly renderStep?: StepRenderers | undefined
  readonly now: () => number
}

/**
 * Consecutive done calls of one tool, merged (spec §3 `StepGroup`). The label
 * already carries the count, so the meta shows the merged sources count when
 * any; the row opens to the individual steps.
 */
export function StepGroup({ group, labels, renderStep, now }: StepGroupProps): ReactElement {
  const { open, toggle } = useDisclosure(false, false)
  const sources = group.steps.reduce((n, step) => n + (step.sources?.length ?? 0), 0)
  return (
    <li
      className="b4-step"
      data-state="done"
      data-kind="group"
      {...(open ? { "data-expanded": "true" } : {})}
    >
      <Disclosure
        className="b4-step__line"
        open={open}
        onToggle={toggle}
        panelClassName="b4-step__children"
        summary={
          <>
            <StepIcon name={group.steps[0]?.icon} />
            <span className="b4-step__text">{group.label}</span>
            <StatusText>
              {sources > 0 ? `· ${sources} source${sources === 1 ? "" : "s"}` : ""}
            </StatusText>
          </>
        }
      >
        <ol className="b4-turn__steps">
          {group.steps.map((step) => (
            <Step key={step.id} step={step} labels={labels} renderStep={renderStep} now={now} />
          ))}
        </ol>
      </Disclosure>
    </li>
  )
}
