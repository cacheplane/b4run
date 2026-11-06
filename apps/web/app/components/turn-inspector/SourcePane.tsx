"use client"
import { useEffect, useState } from "react"
import type { LessonSource } from "../../../lib/turn-inspector/lesson-types"
import { readVerifiedAsset } from "../../../lib/turn-inspector/load-capture"
import { validateSource } from "../../../lib/turn-inspector/source"
import styles from "./inspector.module.css"
export function SourcePane({
  sources,
  moment,
}: {
  sources: LessonSource[]
  moment: string | undefined
}) {
  const [selected, setSelected] = useState(
    sources.find((s) => s.ranges.some((r) => r.moment === moment))?.path ?? sources[0]?.path,
  )
  const source = sources.find((s) => s.path === selected)
  const [lines, setLines] = useState<{ number: number; text: string }[]>([])
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly restarts this request.
  useEffect(() => {
    if (!source) return
    const controller = new AbortController()
    setLines([])
    setError(false)
    void readVerifiedAsset(source.digest, "source", controller.signal)
      .then((text) => {
        if (!controller.signal.aborted)
          setLines(validateSource(text, source).map((text, index) => ({ number: index + 1, text })))
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [source, attempt])
  if (!source) return null
  return (
    <div className={styles.source}>
      <label>
        Example file{" "}
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {sources.map((s) => (
            <option key={s.path} value={s.path}>
              {s.path}
            </option>
          ))}
        </select>
      </label>
      <p>
        Source at revision <code>{source.revision.slice(0, 12)}</code>. This is the example code,
        not a record of which lines executed.
      </p>
      {error ? (
        <p role="status">
          Source could not be loaded.{" "}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      ) : lines.length === 0 ? (
        <p role="status">Loading source…</p>
      ) : (
        <pre className={styles.sourceCode}>
          <code>
            {lines.map((line) => (
              <span
                key={line.number}
                data-highlighted={source.ranges.some(
                  (r) => r.moment === moment && line.number >= r.start && line.number <= r.end,
                )}
              >
                <span aria-hidden="true" className={styles.lineNumber}>
                  {line.number}
                </span>
                {line.text}
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
      )}
    </div>
  )
}
