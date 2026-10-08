import { type ReactElement, useMemo, useState } from "react"
import { type DetailBlock, type DetailField, stepDetailView } from "../../view/activity-format.js"

export interface StepDetailProps {
  readonly args: string
  readonly result?: string | undefined
}

function Fields({ fields }: { readonly fields: readonly DetailField[] }): ReactElement {
  return (
    <dl className="b4-step__fields">
      {fields.map((field) => (
        <div key={field.key} className="b4-step__field">
          <dt>{field.key}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Block({ block }: { readonly block: DetailBlock }): ReactElement {
  switch (block.kind) {
    case "fields":
      return <Fields fields={block.fields} />
    case "records":
      return (
        <ol className="b4-step__records">
          {block.records.map((fields, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Records are positional and never reordered.
            <li key={index}>
              <Fields fields={fields} />
            </li>
          ))}
        </ol>
      )
    case "text":
      return <p className="b4-step__value">{block.text}</p>
    default:
      return <pre className="b4-step__code">{block.text}</pre>
  }
}

/**
 * A step's input and result, readable first (spec §3 `StepDetail`): rows for
 * an object, a group of rows per object in a short list, plain text for a
 * string, pretty JSON for anything deeper.
 * When rows reshaped a value, "Show raw" opens the originals.
 */
export function StepDetail({ args, result }: StepDetailProps): ReactElement {
  const view = useMemo(() => stepDetailView(args, result), [args, result])
  const [showRaw, setShowRaw] = useState(false)
  return (
    <div className="b4-step__detail">
      {view.empty ? <p className="b4-step__detail-empty">No details yet.</p> : null}
      {view.input ? <Block block={view.input} /> : null}
      {view.result ? (
        <>
          <h4 className="b4-step__detail-label">Result</h4>
          <Block block={view.result} />
        </>
      ) : null}
      {view.raw ? (
        <>
          <button
            type="button"
            className="b4-step__raw"
            aria-expanded={showRaw}
            onClick={() => setShowRaw((open) => !open)}
          >
            {showRaw ? "Hide raw" : "Show raw"}
          </button>
          {showRaw && view.raw.input.trim() !== "" ? (
            <>
              <h4 className="b4-step__detail-label">Raw input</h4>
              <pre className="b4-step__code">{view.raw.input}</pre>
            </>
          ) : null}
          {showRaw && view.raw.result.trim() !== "" ? (
            <>
              <h4 className="b4-step__detail-label">Raw result</h4>
              <pre className="b4-step__code">{view.raw.result}</pre>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
