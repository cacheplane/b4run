import type { ReactElement } from "react"
import type { StepSource } from "../../view/turns.js"

export interface SourceChipsProps {
  readonly sources: readonly StepSource[]
  /** Chips shown before the "+N" overflow chip. */
  readonly limit?: number
}

/** File or URL chips from a step's `sources` (spec §3), with "+N" overflow. */
export function SourceChips({ sources, limit = 3 }: SourceChipsProps): ReactElement | null {
  if (sources.length === 0) return null
  const shown = sources.slice(0, limit)
  const more = sources.length - shown.length
  return (
    <ul className="b4-step__sources" aria-label="Sources">
      {shown.map((source, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Sources carry no stable id and two may share a title; the list is never reordered.
        <li key={`${source.title}:${index}`}>
          {source.href ? (
            <a className="b4-chip" href={source.href} target="_blank" rel="noreferrer">
              {source.title}
            </a>
          ) : (
            <span className="b4-chip">{source.title}</span>
          )}
        </li>
      ))}
      {more > 0 ? <li className="b4-chip b4-chip--more">+{more}</li> : null}
    </ul>
  )
}
