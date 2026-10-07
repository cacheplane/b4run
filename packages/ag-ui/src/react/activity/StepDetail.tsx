import { type ReactElement, useMemo } from "react"
import { stepDetailText } from "../../view/activity-format.js"

export interface StepDetailProps {
  readonly args: string
  readonly result?: string | undefined
}

/** A step's Inputs and Output (spec §3 `StepDetail`); CSS caps it at 250px with scroll. */
export function StepDetail({ args, result }: StepDetailProps): ReactElement {
  const { inputs, output, empty } = useMemo(() => stepDetailText(args, result), [args, result])
  return (
    <div className="b4-step__detail">
      {empty ? <p className="b4-step__detail-empty">No details yet.</p> : null}
      {inputs.trim() !== "" ? (
        <>
          <h4 className="b4-step__detail-label">Inputs</h4>
          <pre className="b4-step__code">{inputs}</pre>
        </>
      ) : null}
      {output.trim() !== "" ? (
        <>
          <h4 className="b4-step__detail-label">Output</h4>
          <pre className="b4-step__code">{output}</pre>
        </>
      ) : null}
    </div>
  )
}
