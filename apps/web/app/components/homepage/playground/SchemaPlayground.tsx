"use client"
import { useState } from "react"
import styles from "./playground.module.css"
import type { PlaygroundVariant } from "./types"

type Flag = "formal" | "language" | "jsdoc"
type Flags = Readonly<Record<Flag, boolean>>

const TOGGLES: readonly { readonly flag: Flag; readonly label: string }[] = [
  { flag: "formal", label: "formal?: boolean" },
  { flag: "language", label: 'language: "en" | "es"' },
  { flag: "jsdoc", label: "JSDoc" },
]

const pick = (variants: readonly PlaygroundVariant[], flags: Flags) =>
  variants.find(
    (variant) =>
      variant.formal === flags.formal &&
      variant.language === flags.language &&
      variant.jsdoc === flags.jsdoc,
  )

/** A new sibling adds a trailing comma to the line above it; that is not a change. */
const bare = (line: string) => line.replace(/,$/, "")

/** What the live region says after a toggle. */
export function describeVariant(variant: PlaygroundVariant): string {
  const description = variant.description
    ? `Description: ${variant.description}`
    : "No description, so the model sees only the name greet."
  return `Required: ${variant.required.join(", ")}. ${description}`
}

/**
 * The tool stop's demo: toggle greet.ts's input type and JSDoc, and see the
 * schema the framework extracts for each of the eight recorded variants.
 */
export function SchemaPlayground({
  variants,
}: {
  readonly variants: readonly PlaygroundVariant[]
}) {
  const [flags, setFlags] = useState<Flags>({ formal: false, language: false, jsdoc: true })
  const [before, setBefore] = useState<readonly string[] | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const variant = pick(variants, flags)
  if (!variant) return null
  const previous = before === null ? null : new Set(before.map(bare))

  function toggle(flag: Flag) {
    const next = { ...flags, [flag]: !flags[flag] }
    const target = pick(variants, next)
    if (!variant || !target) return
    setBefore(variant.schemaText)
    setFlags(next)
    setAnnouncement(describeVariant(target))
  }

  return (
    <div className={styles.playground}>
      <fieldset className={styles.toggles} aria-label="Change greet.ts">
        {TOGGLES.map(({ flag, label }) => (
          <button
            key={flag}
            type="button"
            className={styles.toggle}
            aria-pressed={flags[flag]}
            onClick={() => toggle(flag)}
          >
            <span className={styles.box} aria-hidden="true">
              {flags[flag] ? "■" : "□"}
            </span>
            <code>{label}</code>
          </button>
        ))}
      </fieldset>
      <div className={styles.panes}>
        <section className={styles.pane} aria-label="greet.ts source">
          <p className={styles.paneLabel}>src/app/hello/tools/greet.ts</p>
          <pre className={styles.code}>
            <code>
              {variant.sourceLines.map((html, index) => {
                const lineKey = `${variant.id}:source:${index}`
                return (
                  <span key={lineKey} className={styles.line}>
                    {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Only server-produced Shiki tokens; highlightCode escapes all source text. */}
                    <span dangerouslySetInnerHTML={{ __html: html }} />
                  </span>
                )
              })}
            </code>
          </pre>
        </section>
        <section className={styles.pane} aria-label="What the model sees">
          <p className={styles.paneLabel}>What the model sees</p>
          <pre className={styles.code}>
            <code>
              {variant.schemaLines.map((html, index) => {
                const lineKey = `${variant.id}:schema:${index}`
                const changed =
                  previous !== null && !previous.has(bare(variant.schemaText[index] ?? ""))
                return (
                  <span key={lineKey} className={styles.line} data-changed={changed}>
                    <span className={styles.gutter} aria-hidden="true">
                      {changed ? "+" : " "}
                    </span>
                    {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Only server-produced Shiki tokens; highlightCode escapes all source text. */}
                    <span dangerouslySetInnerHTML={{ __html: html }} />
                  </span>
                )
              })}
            </code>
          </pre>
        </section>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
