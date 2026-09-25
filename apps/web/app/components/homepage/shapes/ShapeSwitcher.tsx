"use client"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { gsap, withMotion } from "../motion/gsap"
import { routeShapes, SHAPE_PATH, type ShapeId } from "./route-shapes"
import styles from "./shapes.module.css"

type Fade = ReturnType<typeof gsap.fromTo>

/** Stops a running fade and drops the inline opacity it left behind. */
function stopFade(fade: { current: Fade | null }) {
  const running = fade.current
  fade.current = null
  if (!running) return
  const targets = running.targets()
  running.kill()
  gsap.set(targets, { clearProps: "opacity" })
}

/** What the live region says after the visitor picks a shape. */
export function describeShape(id: ShapeId): string {
  const shape = routeShapes.find((candidate) => candidate.id === id)
  return `Showing ${SHAPE_PATH} as ${id === "agent" ? "an" : "a"} ${id}. ${shape?.strip ?? ""}`
}

/**
 * The route-shape switcher: one radio per shape, and the same hello route
 * written in that shape. Every variant stays mounted in one grid cell, so the
 * tallest reserves the space and switching never moves the page.
 */
export function ShapeSwitcher({
  code,
}: {
  readonly code: Readonly<Record<ShapeId, readonly string[]>>
}) {
  const name = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef(false)
  const fadeRef = useRef<Fade | null>(null)
  const [active, setActive] = useState<ShapeId>("agent")
  const [changes, setChanges] = useState(0)
  const [announcement, setAnnouncement] = useState("")

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = withMotion(root, {
      reduce: () => {
        motionRef.current = false
        stopFade(fadeRef)
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
      stopFade(fadeRef)
    }
  }, [])

  // The state is already final when this runs; the fade only moves pixels, and
  // the next pick kills it.
  useLayoutEffect(() => {
    if (changes === 0) return
    stopFade(fadeRef)
    if (!motionRef.current) return
    const targets = rootRef.current?.querySelectorAll(`[data-shape="${active}"]`)
    if (!targets?.length) return
    fadeRef.current = gsap.fromTo(
      targets,
      { opacity: 0 },
      { opacity: 1, duration: 0.2, ease: "power1.out", clearProps: "opacity" },
    )
  }, [changes, active])

  function choose(id: ShapeId) {
    setActive(id)
    setChanges((count) => count + 1)
    setAnnouncement(describeShape(id))
  }

  return (
    <div ref={rootRef} className={styles.switcher}>
      <fieldset className={styles.options}>
        <legend className={styles.legend}>Route shape</legend>
        {routeShapes.map((shape) => (
          <label key={shape.id} className={styles.option}>
            <input
              type="radio"
              name={name}
              value={shape.id}
              checked={shape.id === active}
              onChange={() => choose(shape.id)}
            />
            <span>{shape.id}</span>
          </label>
        ))}
      </fieldset>
      <div className={styles.panel}>
        <p className={styles.path}>{SHAPE_PATH}</p>
        <div className={styles.stage}>
          {routeShapes.map((shape) => {
            const on = shape.id === active
            return (
              <pre
                key={shape.id}
                className={styles.code}
                data-shape={shape.id}
                data-active={on}
                aria-hidden={on ? undefined : true}
                inert={on ? undefined : true}
              >
                <code>
                  {code[shape.id].map((html, index) => {
                    const lineKey = `${shape.id}:${index}`
                    return (
                      <span
                        key={lineKey}
                        className={styles.line}
                        // biome-ignore lint/security/noDangerouslySetInnerHtml: Only server-produced Shiki tokens; highlightCode escapes all source text.
                        dangerouslySetInnerHTML={{ __html: html }}
                      />
                    )
                  })}
                </code>
              </pre>
            )
          })}
        </div>
        <div className={styles.stage}>
          {routeShapes.map((shape) => {
            const on = shape.id === active
            return (
              <p
                key={shape.id}
                className={styles.strip}
                data-shape={shape.id}
                data-active={on}
                aria-hidden={on ? undefined : true}
                inert={on ? undefined : true}
              >
                <code>{shape.export}</code>
                <span>{shape.strip}</span>
                <a href={shape.docsHref}>{shape.docsLabel} →</a>
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
