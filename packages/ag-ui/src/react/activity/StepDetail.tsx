import type { ReactElement } from "react"

/** JSON pretty-printed with two spaces; anything else (or invalid JSON) as-is. Never throws. */
export function prettyValue(text: string): string {
  if (text.trim() === "") return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export interface StepDetailProps {
  readonly args: string
  readonly result?: string | undefined
}

/** A step's Inputs and Output (spec §3 `StepDetail`); CSS caps it at 250px with scroll. */
export function StepDetail({ args, result }: StepDetailProps): ReactElement {
  const inputs = prettyValue(args)
  const output = result === undefined ? "" : prettyValue(result)
  const empty = inputs.trim() === "" && output.trim() === ""
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
