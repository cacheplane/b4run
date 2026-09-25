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
  // `formal` is the only field that's ever optional, so naming it here is what
  // makes a toggle that never touches `required` still change the announcement.
  const optional = variant.formal ? "Optional: formal." : "Optional: none."
  const description = variant.description
    ? `Description: ${variant.description}`
    : "No description, so the model sees only the name greet."
  return `Required: ${variant.required.join(", ")}. ${optional} ${description}`
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
          {/* Every variant stays mounted, stacked in one grid cell, so the
              tallest one reserves the space and toggling never shifts layout.
              Only the active variant is visible or reachable. */}
          <div className={styles.stage}>
            {variants.map((item) => {
              const active = item.id === variant.id
              return (
                <pre
                  key={item.id}
                  className={styles.code}
                  data-active={active}
                  aria-hidden={active ? undefined : true}
                  inert={active ? undefined : true}
                >
                  <code>
                    {item.sourceLines.map((html, index) => {
                      const lineKey = `${item.id}:source:${index}`
                      return (
                        <span key={lineKey} className={styles.line}>
                          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Only server-produced Shiki tokens; highlightCode escapes all source text. */}
                          <span dangerouslySetInnerHTML={{ __html: html }} />
                        </span>
                      )
                    })}
                  </code>
                </pre>
              )
            })}
          </div>
        </section>
        <section className={styles.pane} aria-label="What the model sees">
          <p className={styles.paneLabel}>What the model sees</p>
          <div className={styles.stage}>
            {variants.map((item) => {
              const active = item.id === variant.id
              return (
                <pre
                  key={item.id}
                  className={styles.code}
                  data-active={active}
                  aria-hidden={active ? undefined : true}
                  inert={active ? undefined : true}
                >
                  <code>
                    {item.schemaLines.map((html, index) => {
                      const lineKey = `${item.id}:schema:${index}`
                      const changed =
                        active &&
                        previous !== null &&
                        !previous.has(bare(item.schemaText[index] ?? ""))
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
              )
            })}
          </div>
        </section>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
