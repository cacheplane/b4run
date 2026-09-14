"use client"
import { useState } from "react"
import { CodePanel } from "./CodePanel"
import styles from "./homepage.module.css"
import type { WalkthroughProps } from "./types"

const steps = ["reproduce", "repair", "verify"] as const
const labels = ["Reproduce", "Repair", "Verify + review"]
const files = ["agent", "config", "plan"] as const
const fileLabels = ["index.ts", "b4.config.ts", "plan.md"]

export function Walkthrough(props: WalkthroughProps) {
  const [step, setStep] = useState<(typeof steps)[number]>("verify")
  const [file, setFile] = useState<(typeof files)[number]>("agent")
  return (
    <section className={styles.walkthrough} aria-labelledby="walkthrough-title" id="blueprint">
      <div className={styles.sectionHeading}>
        <h2 id="walkthrough-title">This code runs this agent.</h2>
        <p>
          Recorded run · 1m 53s
          <br />
          Edited highlights · gpt-5
        </p>
      </div>
      <fieldset className={styles.steps} aria-label="Explore the recorded run">
        {steps.map((key, i) => (
          <button
            type="button"
            key={key}
            data-step={key}
            aria-pressed={key === step}
            onClick={() => setStep(key)}
          >
            <span>0{i + 1}</span>
            {labels[i]}
          </button>
        ))}
      </fieldset>
      <div className={styles.walkthroughGrid}>
        <div className={styles.proof} aria-live="polite">
          <p className={styles.proofLabel}>
            {step === "verify"
              ? "✓ Independent verification passed"
              : step === "repair"
                ? "Source change captured"
                : "Failure reproduced"}
          </p>
          <h3>
            {step === "verify" ? (
              <>
                Fixed. Verified.
                <br />
                Ready for your review.
              </>
            ) : step === "repair" ? (
              <>
                A focused fix.
                <br />A readable diff.
              </>
            ) : (
              <>
                Start with a failure.
                <br />
                Make it repeatable.
              </>
            )}
          </h3>
          <p className={styles.brief}>
            {step === "verify"
              ? "A fresh sandbox checked the agent’s patch."
              : step === "repair"
                ? "One source file changed. Tests and configuration stayed intact."
                : "The agent ran the failing test before editing source."}
          </p>
          {step === "verify" ? (
            <>
              <pre className={styles.receipt}>
                {`VISIBLE TESTS ${props.visible.length} / ${props.visible.length} passed\nINDEPENDENT CHECKS ${props.independent.length} / ${props.independent.length} passed`}
              </pre>
              <ul className={styles.checks}>
                {[...props.visible, ...props.independent].map((name) => (
                  <li key={name}>
                    <span aria-hidden="true">✓</span>
                    {name}
                  </li>
                ))}
              </ul>
              <div className={styles.approval}>
                <strong>Awaiting your approval</strong>
                <span>exportForReview paused. Nothing exported.</span>
              </div>
            </>
          ) : step === "repair" ? (
            <CodePanel code={props.patch} />
          ) : (
            <pre className={styles.failure}>
              $ {props.command}
              {"\n\n"}
              {props.failure}
              {"\n\n"}1 test · 1 failure
            </pre>
          )}
        </div>
        <div className={styles.agentSource} data-source={file}>
          <fieldset className={styles.fileTabs} aria-label="Agent source files">
            {files.map((key, i) => (
              <button
                type="button"
                key={key}
                aria-pressed={file === key}
                onClick={() => setFile(key)}
              >
                {fileLabels[i]}
              </button>
            ))}
          </fieldset>
          <CodePanel
            key={file}
            code={props.files[file]}
            {...(file === "agent"
              ? { emphasis: step === "verify" ? 7 : step === "reproduce" ? 8 : 6 }
              : {})}
          />
        </div>
      </div>
    </section>
  )
}
