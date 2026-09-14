"use client"
import { useState } from "react"
import { CodePanel } from "./CodePanel"
import styles from "./homepage.module.css"
import type { Capability } from "./types"

export function Capabilities({ items }: { readonly items: readonly Capability[] }) {
  const [selected, setSelected] = useState("sandbox")
  const current = items.find((item) => item.key === selected) ?? items[0]
  if (!current) return null
  return (
    <section className={styles.capabilities} aria-labelledby="capabilities-title">
      <p className={styles.eyebrow}>Real capabilities. Real TypeScript.</p>
      <div className={styles.intro}>
        <h2 id="capabilities-title">
          Give it tools.
          <br />
          Keep the controls.
        </h2>
        <p>
          Files. Execution. Evals. Approval.
          <br />
          Open the code behind each one.
        </p>
      </div>
      <div className={styles.capGrid}>
        <fieldset className={styles.capOptions} aria-label="Explore capabilities">
          {items.map((item, i) => (
            <button
              type="button"
              key={item.key}
              aria-pressed={item.key === selected}
              onClick={() => setSelected(item.key)}
            >
              <span className={styles.number}>0{i + 1}</span>
              <span>
                <strong>{item.name}</strong>
                <small>{item.lead}</small>
              </span>
            </button>
          ))}
        </fieldset>
        <div className={styles.capCode} aria-live="polite">
          <p>{current.explanation}</p>
          <CodePanel key={current.key} code={current.code} />
        </div>
      </div>
    </section>
  )
}
