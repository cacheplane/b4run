import { type ReactElement, useState } from "react"
import type { ReasoningStep as ReasoningStepView } from "../../view/turns.js"
import { Disclosure } from "./Disclosure.js"
import { reasoningLabel } from "./format.js"
import { StepIcon } from "./icons.js"

/**
 * A reasoning span (spec §3 `ReasoningStep`): opens to its text while
 * streaming and on demand once done; an encrypted span (done with no text)
 * is not openable, so its line is a plain `span` rather than a button.
 */
export function ReasoningStep({ step }: { readonly step: ReasoningStepView }): ReactElement {
  const streaming = step.status === "streaming"
  const encrypted = !streaming && step.text.trim() === ""
  const [expanded, setExpanded] = useState(streaming)
  const summary = (
    <>
      <StepIcon name="think" />
      <span className="b4-step__text">{reasoningLabel(step)}</span>
    </>
  )
  return (
    <li
      className="b4-step"
      data-state={streaming ? "running" : "done"}
      data-kind="reasoning"
      {...(expanded && !encrypted ? { "data-expanded": "true" } : {})}
    >
      {encrypted ? (
        <span className="b4-step__line b4-step__line--static">{summary}</span>
      ) : (
        <Disclosure
          className="b4-step__line"
          autoOpen={streaming}
          live={streaming}
          onOpenChange={setExpanded}
          panelClassName="b4-step__detail"
          summary={summary}
        >
          <p className="b4-step__reasoning">{step.text}</p>
        </Disclosure>
      )}
    </li>
  )
}
