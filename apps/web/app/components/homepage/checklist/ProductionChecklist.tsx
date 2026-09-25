"use client"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { gsap, withMotion } from "../motion/gsap"
import { type ChecklistId, type ChecklistItem, checklist, describeToggle } from "./checklist"
import styles from "./checklist.module.css"

type Flip = ReturnType<typeof gsap.fromTo>

/** Stops a running flip and drops the inline styles it left behind. */
function stopFlip(flip: { current: Flip | null }) {
  const running = flip.current
  flip.current = null
  if (!running) return
  const targets = running.targets()
  running.kill()
  gsap.set(targets, { clearProps: "opacity,transform" })
}

const EVERY_ID: ReadonlySet<ChecklistId> = new Set(checklist.map((item) => item.id))

/**
 * The production checklist: twelve tiles, each a toggle button that turns its
 * tile over to show what handles that part. The server renders every tile
 * turned over, so the answers are there without JavaScript; the island turns
 * them back once it runs. Each tile's two faces share one grid cell, so a
 * turn never moves the page. The state and the announcement change at once;
 * the 300ms rotateY only moves pixels, and the next turn kills it.
 */
export function ProductionChecklist() {
  const rootRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef(false)
  const flipRef = useRef<Flip | null>(null)
  const [open, setOpen] = useState<ReadonlySet<ChecklistId>>(EVERY_ID)
  const [turn, setTurn] = useState<{ readonly id: ChecklistId; readonly count: number } | null>(
    null,
  )
  const [focusTarget, setFocusTarget] = useState<ChecklistId | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const done = open.size === checklist.length

  // Turn every tile face down once JavaScript runs, before the browser paints,
  // so a client navigation never shows a frame of open tiles. If focus is
  // already on a docs link this hides, hand it to that tile's button.
  useLayoutEffect(() => {
    const focused = document.activeElement
    const face = focused?.closest("[data-face]")
    const item = face ? rootRef.current?.contains(face) && face.closest("[data-item]") : null
    setOpen(new Set())
    const id = item ? item.getAttribute("data-item") : null
    if (id && EVERY_ID.has(id as ChecklistId)) setFocusTarget(id as ChecklistId)
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = withMotion(root, {
      reduce: () => {
        motionRef.current = false
        stopFlip(flipRef)
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
      stopFlip(flipRef)
    }
  }, [])

  // The tile is already turned when this runs: swing the face now showing in
  // from edge-on. Its back face stays hidden, so only one face ever shows.
  useLayoutEffect(() => {
    if (turn === null) return
    stopFlip(flipRef)
    if (!motionRef.current) return
    const face = rootRef.current?.querySelector(
      `[data-item="${turn.id}"] [data-face][data-active="true"]`,
    )
    if (!face) return
    flipRef.current = gsap.fromTo(
      face,
      { rotateY: -90 },
      { rotateY: 0, duration: 0.3, ease: "power2.out", clearProps: "transform" },
    )
  }, [turn])

  useLayoutEffect(() => {
    if (focusTarget === null) return
    rootRef.current?.querySelector<HTMLElement>(`[data-toggle="${focusTarget}"]`)?.focus()
    setFocusTarget(null)
  }, [focusTarget])

  function toggle(item: ChecklistItem) {
    const next = new Set(open)
    const nowOpen = !next.has(item.id)
    if (nowOpen) next.add(item.id)
    else next.delete(item.id)
    // Safari doesn't focus a clicked button: WebKit moves focus on mousedown
    // to the nearest focusable ancestor (<main tabindex="-1"> or <body>).
    // Focus may also sit on a docs link this turn hides. Give it to the button.
    const root = rootRef.current
    const focused = document.activeElement
    const stranded =
      root !== null &&
      (focused === null ||
        focused.contains(root) ||
        (root.contains(focused) && !focused.matches("[data-toggle]")))
    setOpen(next)
    setTurn((previous) => ({ id: item.id, count: (previous?.count ?? 0) + 1 }))
    setAnnouncement(describeToggle(item, nowOpen, next.size))
    if (stranded) setFocusTarget(item.id)
  }

  return (
    <div ref={rootRef} className={styles.checklist}>
      <p className={styles.counter}>
        <span data-counter="">
          {open.size} of {checklist.length} opened
        </span>
        <span className={styles.handled} data-done={done} aria-hidden={done ? undefined : true}>
          <span className={styles.dot} aria-hidden="true" />
          Handled.
        </span>
      </p>
      <ol className={styles.grid}>
        {checklist.map((item, index) => {
          const on = open.has(item.id)
          return (
            <li key={item.id} className={styles.tile} data-item={item.id} data-open={on}>
              <button
                type="button"
                className={styles.toggle}
                data-toggle={item.id}
                aria-pressed={on}
                onClick={() => toggle(item)}
              >
                <span className={styles.number} aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>{item.title}</span>
              </button>
              <div className={styles.faces}>
                <p
                  className={styles.face}
                  data-face="chore"
                  data-active={!on}
                  aria-hidden={on ? true : undefined}
                  inert={on ? true : undefined}
                >
                  {item.chore}
                </p>
                <div
                  className={styles.face}
                  data-face="handled"
                  data-active={on}
                  aria-hidden={on ? undefined : true}
                  inert={on ? undefined : true}
                >
                  <p className={styles.answer}>{item.handledBy}</p>
                  {item.file && <p className={styles.file}>{item.file}</p>}
                  <pre className={styles.code}>
                    <code>{item.code}</code>
                  </pre>
                  <a href={item.docsHref}>{item.docsLabel} →</a>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
