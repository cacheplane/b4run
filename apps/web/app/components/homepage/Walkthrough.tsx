"use client"
import { useState } from "react"
import { Eyebrow } from "../ui/Eyebrow"
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
        <h2 id="walkthrough-title">One run, start to finish.</h2>
        <p>Recorded with gpt-5</p>
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
          <Eyebrow className={styles.proofLabel}>
            {step === "verify"
              ? "✓ Independent verification passed"
              : step === "repair"
                ? "Source change captured"
                : "Failure reproduced"}
          </Eyebrow>
          <h3>
            {step === "verify" ? (
              <>
                The fix passed every check.
                <br />
                It’s waiting for your review.
              </>
            ) : step === "repair" ? (
              <>
                The agent made one focused fix.
                <br />
                You can read the whole diff.
              </>
            ) : (
              "First, reproduce the failure."
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
                <span>exportForReview is paused. Nothing has been exported.</span>
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
          <Eyebrow tone="panel" className={styles.eyebrow}>
            Agent source
          </Eyebrow>
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
