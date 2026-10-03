import { Eyebrow } from "../../ui/Eyebrow"
import { GateTracer } from "./GateTracer"
import { GUARDRAILS_LINK } from "./gate-scenarios"
import styles from "./gates.module.css"
import type { GatesData } from "./prepare"

/**
 * "Guardrails": the four checks between the model and your system. The tracer
 * is the island; the server renders it with the first call traced and every
 * other board in the DOM.
 */
export function Guardrails(data: GatesData) {
  return (
    <section id="guardrails" className={styles.section} aria-labelledby="guardrails-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>Guardrails</Eyebrow>
        <h2 id="guardrails-title">Four checks decide what a call can do.</h2>
        <p>
          Tool scope, permissions, the sandbox and delegation each answer one question. Pick a call
          this support agent might make and see which checks it meets.
        </p>
      </div>
      <GateTracer {...data} />
      <p className={styles.links}>
        <a href={GUARDRAILS_LINK.href}>{GUARDRAILS_LINK.label} →</a>
      </p>
    </section>
  )
}
