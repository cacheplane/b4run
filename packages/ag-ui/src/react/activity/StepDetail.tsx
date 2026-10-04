import { type ReactElement, useMemo } from "react"

/** JSON pretty-printed with two spaces; anything else (or invalid JSON) as-is. Never throws. */
export function prettyValue(text: string): string {
  if (text.trim() === "") return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** A step's inputs or output longer than this is cut; a tool can return megabytes. */
export const MAX_DETAIL_CHARS = 20_000

/** `text`, or its first `MAX_DETAIL_CHARS` characters followed by a "… (truncated)" line. */
export function capDetail(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n… (truncated)` : text
}

export interface StepDetailProps {
  readonly args: string
  readonly result?: string | undefined
}

/** A step's Inputs and Output (spec §3 `StepDetail`); CSS caps it at 250px with scroll. */
export function StepDetail({ args, result }: StepDetailProps): ReactElement {
  const inputs = useMemo(() => capDetail(prettyValue(args)), [args])
  const output = useMemo(
    () => (result === undefined ? "" : capDetail(prettyValue(result))),
    [result],
  )
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
