"use client"
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react"
import { gsap, withMotion } from "../motion/gsap"
import styles from "./ship.module.css"
import { describeReplay, type ReplayId, testReplay } from "./ship-data"

type Stream = ReturnType<typeof gsap.fromTo>

/** Stops a running replay and drops the inline opacity it left on its lines. */
function stopStream(stream: { current: Stream | null }) {
  const running = stream.current
  stream.current = null
  if (!running) return
  const targets = running.targets()
  running.kill()
  gsap.set(targets, { clearProps: "opacity" })
}

/**
 * Safari doesn't focus a clicked button: WebKit moves focus on mousedown to
 * the nearest focusable ancestor (<main tabindex="-1"> or <body>). Put it on
 * the button, so the next Tab continues from here.
 */
function keepFocus(event: MouseEvent<HTMLButtonElement>) {
  const button = event.currentTarget
  const focused = document.activeElement
  if (focused === null || (focused !== button && focused.contains(button))) button.focus()
}

/** The button label for each run: the command a visitor would type. */
const LABEL: Readonly<Record<ReplayId, string>> = { test: "npm test", eval: "b4 eval" }

/**
 * The scaffold's recorded `npm test` and `b4 eval`. Every line is in the page
 * from the start, so the terminal is its final height and a screen reader can
 * read the whole log. Replaying sets the announcement at once and only fades
 * the lines in, about 80ms apart; Skip, the next replay, or reduced motion
 * shows them all at once.
 */
export function TestReplay() {
  const rootRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef(false)
  const streamRef = useRef<Stream | null>(null)
  const [replaying, setReplaying] = useState<ReplayId | null>(null)
  const [replays, setReplays] = useState(0)
  const [announcement, setAnnouncement] = useState("")

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = withMotion(root, {
      reduce: () => {
        motionRef.current = false
        stopStream(streamRef)
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
      stopStream(streamRef)
    }
  }, [])

  // The log is already complete when this runs; the stream only moves pixels,
  // and the next action kills it.
  useLayoutEffect(() => {
    if (replays === 0 || replaying === null) return
    stopStream(streamRef)
    if (!motionRef.current) return
    const lines = rootRef.current?.querySelectorAll(`[data-run="${replaying}"] [data-replay-line]`)
    if (!lines?.length) return
    streamRef.current = gsap.fromTo(
      lines,
      { opacity: 0 },
      { opacity: 1, duration: 0.01, ease: "none", stagger: 0.08, clearProps: "opacity" },
    )
  }, [replays, replaying])

  function replay(id: ReplayId) {
    const run = testReplay.runs.find((candidate) => candidate.id === id)
    if (!run) return
    setReplaying(id)
    setReplays((count) => count + 1)
    setAnnouncement((current) =>
      current === describeReplay(run, false)
        ? describeReplay(run, true)
        : describeReplay(run, false),
    )
  }

  return (
    <div ref={rootRef} className={styles.replay}>
      <div className={styles.controls}>
        {testReplay.runs.map((run) => (
          <button
            key={run.id}
            type="button"
            data-replay={run.id}
            onClick={(event) => {
              keepFocus(event)
              replay(run.id)
            }}
          >
            <span aria-hidden="true">▶ </span>Replay {LABEL[run.id]}
          </button>
        ))}
        <button
          type="button"
          data-action="skip"
          onClick={(event) => {
            keepFocus(event)
            stopStream(streamRef)
          }}
        >
          Skip
        </button>
      </div>
      <div className={styles.terminal}>
        <p className={styles.bar}>{testReplay.app}</p>
        <pre
          className={styles.log}
          role="log"
          aria-live="off"
          aria-label={`Recorded output in ${testReplay.app}`}
        >
          <code>
            {testReplay.runs.map((run) => (
              <span key={run.id} className={styles.run} data-run={run.id}>
                <span className={styles.line}>
                  <span className={styles.prompt} aria-hidden="true">
                    ${" "}
                  </span>
                  {run.command}
                </span>
                {run.lines.map((line, index) => {
                  const lineKey = `${run.id}:${index}`
                  return (
                    <span key={lineKey} className={styles.line} data-replay-line="">
                      {line || " "}
                    </span>
                  )
                })}
              </span>
            ))}
          </code>
        </pre>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
