"use client"
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { gsap, withMotion } from "../motion/gsap"
import {
  boardFor,
  type ConfigFileId,
  type Decision,
  describeBoard,
  GATES,
  gateBoards,
  gateScenarios,
  pausesFor,
  type ScenarioId,
  STATE_GLYPH,
  STATE_LABEL,
} from "./gate-scenarios"
import styles from "./gates.module.css"
import type { GatesData } from "./prepare"

/** Where focus goes once React has committed a change. */
type FocusTarget = "decision" | "again" | null

interface Trace {
  readonly timeline: ReturnType<typeof gsap.timeline>
  readonly targets: readonly Element[]
}

/** Stops a running trace and drops the inline styles it left behind. */
function stopTrace(trace: { current: Trace | null }) {
  const running = trace.current
  trace.current = null
  if (!running) return
  running.timeline.kill()
  gsap.set(running.targets, { clearProps: "opacity,transform" })
}

const FILE_IDS: readonly ConfigFileId[] = ["route", "config"]

/**
 * The four-gate call tracer. Picking a call sets every label, attribute and
 * the announcement at once; the GSAP timeline only walks the eye across the
 * gates, and the next pick kills it. Every board and file stays mounted in one
 * grid cell, so nothing moves the page.
 */
export function GateTracer({ files, whyLines }: GatesData) {
  const name = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef(false)
  const traceRef = useRef<Trace | null>(null)
  // Arrow keys move through a radio group and check as they go; they must not
  // pull focus out of the group. Only a click, or Space, moves focus on.
  const arrowRef = useRef(false)
  const [scenario, setScenario] = useState<ScenarioId>("read")
  const [decision, setDecision] = useState<Decision | null>(null)
  const [runs, setRuns] = useState(0)
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null)
  const [announcement, setAnnouncement] = useState("")
  const active = boardFor(scenario, decision)
  const file = gateScenarios.find((candidate) => candidate.id === scenario)?.file ?? "route"

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = withMotion(root, {
      reduce: () => {
        motionRef.current = false
        stopTrace(traceRef)
        return undefined
      },
      full: () => {
        motionRef.current = true
        return () => {
          motionRef.current = false
        }
      },
    })
    return () => {
      stop()
      stopTrace(traceRef)
    }
  }, [])

  // Walk the new board's gates, 180ms each. The board is already final.
  useLayoutEffect(() => {
    if (runs === 0) return
    stopTrace(traceRef)
    if (!motionRef.current) return
    const board = rootRef.current?.querySelector(`[data-board="${active}"]`)
    if (!board) return
    const gates = [...board.querySelectorAll("[data-gate]")]
    const result = [...board.querySelectorAll("[data-result]")]
    const timeline = gsap.timeline()
    for (const gate of gates) {
      timeline.fromTo(
        gate,
        { opacity: 0.25, y: 6 },
        { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" },
      )
    }
    timeline.fromTo(result, { opacity: 0 }, { opacity: 1, duration: 0.18 })
    const trace: Trace = { timeline, targets: [...gates, ...result] }
    timeline.eventCallback("onComplete", () => {
      if (traceRef.current === trace) stopTrace(traceRef)
    })
    traceRef.current = trace
  }, [runs, active])

  // Focus moves only after React commits, when the target is no longer inert.
  useEffect(() => {
    if (focusTarget === null) return
    const selector =
      focusTarget === "decision"
        ? `[data-board="${active}"] [data-decision="once"]`
        : `[data-board="${active}"] [data-action="again"]`
    rootRef.current?.querySelector<HTMLButtonElement>(selector)?.focus()
    setFocusTarget(null)
  }, [focusTarget, active])

  function show(next: ScenarioId, answer: Decision | null, focus: FocusTarget) {
    const board = gateBoards.find((candidate) => candidate.id === boardFor(next, answer))
    setScenario(next)
    setDecision(answer)
    setRuns((count) => count + 1)
    setFocusTarget(focus)
    if (board) setAnnouncement(describeBoard(board))
  }

  function pick(next: ScenarioId) {
    const viaArrow = arrowRef.current
    arrowRef.current = false
    show(next, null, pausesFor(next) && !viaArrow ? "decision" : null)
  }

  function trackArrows(event: KeyboardEvent) {
    arrowRef.current = event.type === "keydown" && event.key.startsWith("Arrow")
  }

  return (
    <div ref={rootRef} className={styles.tracer}>
      <fieldset className={styles.calls} onKeyDown={trackArrows} onKeyUp={trackArrows}>
        <legend className={styles.legend}>Pick a call the support agent makes</legend>
        <div className={styles.callList}>
          {gateScenarios.map((candidate) => (
            <label key={candidate.id} className={styles.call}>
              <input
                type="radio"
                name={name}
                value={candidate.id}
                checked={candidate.id === scenario}
                onChange={() => pick(candidate.id)}
              />
              <code>{candidate.call}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <div className={styles.stage}>
        {gateBoards.map((board) => {
          const on = board.id === active
          const call = gateScenarios.find((candidate) => candidate.id === board.scenario)?.call
          return (
            <div
              key={board.id}
              className={styles.board}
              data-board={board.id}
              data-active={on}
              aria-hidden={on ? undefined : true}
              inert={on ? undefined : true}
            >
              <ol className={styles.gates} aria-label={`The four checks for ${call}`}>
                {board.steps.map((step, index) => (
                  <li
                    key={step.gate}
                    className={styles.gate}
                    data-gate={step.gate}
                    data-state={step.state}
                  >
                    <span className={styles.gateName}>
                      {index + 1} · {GATES[index]?.label}
                    </span>
                    <span className={styles.gateState}>
                      <span aria-hidden="true">{STATE_GLYPH[step.state]}</span>{" "}
                      {STATE_LABEL[step.state]}
                    </span>
                    <span className={styles.gateNote}>{step.note}</span>
                  </li>
                ))}
              </ol>
              <p className={styles.result} data-result="">
                {board.result}
              </p>
              {pausesFor(board.scenario) && board.id === board.scenario && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    data-decision="once"
                    onClick={() => show(board.scenario, "once", "again")}
                  >
                    Allow once
                  </button>
                  <button
                    type="button"
                    data-decision="deny"
                    onClick={() => show(board.scenario, "deny", "again")}
                  >
                    Deny
                  </button>
                </div>
              )}
              {pausesFor(board.scenario) && board.id !== board.scenario && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    data-action="again"
                    onClick={() => show(board.scenario, null, "decision")}
                  >
                    Ask again
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className={styles.panel}>
        <div className={styles.stage}>
          {FILE_IDS.map((id) => {
            const on = id === file
            return (
              <div
                key={id}
                data-file={id}
                data-active={on}
                aria-hidden={on ? undefined : true}
                inert={on ? undefined : true}
              >
                <p className={styles.path}>{files[id].path}</p>
                <pre className={styles.code}>
                  <code>
                    {files[id].lines.map((html, index) => {
                      const lineKey = `${id}:${index}`
                      const why = on && whyLines[scenario].includes(index)
                      return (
                        <span key={lineKey} className={styles.line} data-why={why}>
                          <span className={styles.gutter} aria-hidden="true">
                            {why ? "›" : " "}
                          </span>
                          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Only server-produced Shiki tokens; highlightCode escapes all source text. */}
                          <span dangerouslySetInnerHTML={{ __html: html }} />
                        </span>
                      )
                    })}
                  </code>
                </pre>
              </div>
            )
          })}
        </div>
        <div className={styles.stage}>
          {gateScenarios.map((candidate) => {
            const on = candidate.id === scenario
            return (
              <p
                key={candidate.id}
                className={styles.explain}
                data-scenario={candidate.id}
                data-active={on}
                aria-hidden={on ? undefined : true}
                inert={on ? undefined : true}
              >
                <span>{candidate.explain}</span>
                <a href={candidate.docsHref}>{candidate.docsLabel} →</a>
              </p>
            )
          })}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
