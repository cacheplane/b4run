"use client"
import { useState } from "react"
import styles from "./homepage.module.css"
import type { DisplayCode } from "./types"

export function CodePanel({
  code,
  emphasis,
}: {
  readonly code: DisplayCode
  readonly emphasis?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [copy, setCopy] = useState("")
  async function copySource() {
    try {
      await navigator.clipboard.writeText(code.raw)
      setCopy("Copied")
    } catch {
      setCopy("Copy unavailable — select the source below.")
    }
  }
  return (
    <section className={styles.codePanel} aria-label={code.path}>
      <div className={styles.codeHeading}>
        <span>{code.path}</span>
        <a href={code.url} target="_blank" rel="noopener noreferrer">
          {code.linkLabel ?? "Full source"} ↗
        </a>
      </div>
      {code.fold && (
        <button
          className={styles.fold}
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide instructions" : "Show instructions"} · exact source
        </button>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users can scroll long source lines in this named code region. */}
      <pre className={styles.code} tabIndex={0}>
        <code>
          {code.lines.map((html, index) => {
            const line = index + code.firstLine
            const folded =
              code.fold && !expanded && line >= code.fold.start && line <= code.fold.end
            if (folded)
              return line === code.fold?.start ? (
                <span
                  key={line}
                  className={`${styles.foldMarker} ${emphasis !== undefined && emphasis >= code.fold.start && emphasis <= code.fold.end ? styles.highlightLine : ""}`}
                >
                  {" "}
                  systemPrompt · instructions folded
                </span>
              ) : null
            return (
              <span
                key={line}
                className={`${styles.codeLine} ${line === emphasis ? styles.highlightLine : ""}`}
              >
                <span aria-hidden="true" className={styles.lineNumber}>
                  {line}
                </span>
                {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Only server-produced Shiki tokens; highlightCode escapes all source text. */}
                <span dangerouslySetInnerHTML={{ __html: html }} />
              </span>
            )
          })}
        </code>
      </pre>
      <div className={styles.codeFooter}>
        <button type="button" onClick={copySource}>
          Copy source
        </button>
        <span role="status">{copy || "Exact source. No generated ellipses in copy."}</span>
      </div>
    </section>
  )
}
