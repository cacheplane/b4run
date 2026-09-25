"use client"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { gsap, withMotion } from "../motion/gsap"
import styles from "./ship.module.css"
import { buildFor, buildOutputs, deployTargets, describeTarget, type TargetId } from "./ship-data"

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

/**
 * The deploy-target switcher: one radio per target, and for each the
 * b4.config.ts line that selects it and the recorded `b4 build` output. Every
 * target stays mounted in one grid cell, so the tallest reserves the space.
 */
export function DeployTargets({
  code,
}: {
  readonly code: Readonly<Record<TargetId, readonly string[]>>
}) {
  const name = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const optionsRef = useRef<HTMLFieldSetElement>(null)
  const motionRef = useRef(false)
  const fadeRef = useRef<Fade | null>(null)
  const [active, setActive] = useState<TargetId>("node")
  const [changes, setChanges] = useState(0)
  const [refocus, setRefocus] = useState(false)
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

  useLayoutEffect(() => {
    if (changes === 0) return
    stopFade(fadeRef)
    if (!motionRef.current) return
    const target = rootRef.current?.querySelector(`[data-target="${active}"]`)
    if (!target) return
    fadeRef.current = gsap.fromTo(
      target,
      { opacity: 0 },
      { opacity: 1, duration: 0.2, ease: "power1.out", clearProps: "opacity" },
    )
  }, [changes, active])

  // Focus moves once React commits, when the old target is inert.
  useLayoutEffect(() => {
    if (!refocus) return
    rootRef.current?.querySelector<HTMLInputElement>(`input[value="${active}"]`)?.focus()
    setRefocus(false)
  }, [refocus, active])

  function choose(id: TargetId) {
    const target = deployTargets.find((candidate) => candidate.id === id)
    if (!target) return
    // Clicking a label doesn't focus its radio in Safari, and WebKit may have
    // moved focus on mousedown to an ancestor (<main tabindex="-1"> or
    // <body>). Focus may also sit on a docs link this change makes inert.
    // Give it to the newly checked radio.
    const root = rootRef.current
    const focused = document.activeElement
    const stranded =
      root !== null &&
      (focused === null ||
        ((root.contains(focused) || focused.contains(root)) &&
          optionsRef.current?.contains(focused) !== true))
    setActive(id)
    setChanges((count) => count + 1)
    setAnnouncement(describeTarget(target))
    setRefocus(stranded)
  }

  return (
    <div ref={rootRef}>
      <fieldset ref={optionsRef} className={styles.options}>
        <legend className={styles.legend}>Deploy target</legend>
        {deployTargets.map((target) => (
          <label key={target.id} className={styles.option}>
            <input
              type="radio"
              name={name}
              value={target.id}
              checked={target.id === active}
              onChange={() => choose(target.id)}
            />
            <span>{target.id}</span>
          </label>
        ))}
      </fieldset>
      <div className={styles.stage}>
        {deployTargets.map((target) => {
          const on = target.id === active
          const build = buildFor(target.build)
          return (
            <div
              key={target.id}
              className={styles.panel}
              data-target={target.id}
              data-active={on}
              aria-hidden={on ? undefined : true}
              inert={on ? undefined : true}
            >
              <p className={styles.path}>b4.config.ts</p>
              <pre className={styles.code}>
                <code>
                  {code[target.id].map((html, index) => {
                    const lineKey = `${target.id}:config:${index}`
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
              <pre className={styles.output}>
                <code>
                  {[buildOutputs.command, ...target.after].map((command, commandIndex) => (
                    <span key={command} className={styles.run}>
                      {command.split("\n").map((part, index) => {
                        const partKey = `${command}:${index}`
                        return (
                          <span key={partKey} className={styles.line}>
                            <span className={styles.prompt} aria-hidden="true">
                              {index === 0 ? "$ " : "  "}
                            </span>
                            {part}
                          </span>
                        )
                      })}
                      {commandIndex === 0 &&
                        build.lines.map((line, index) => {
                          const lineKey = `${target.id}:out:${index}`
                          return (
                            <span key={lineKey} className={styles.line}>
                              {line}
                            </span>
                          )
                        })}
                    </span>
                  ))}
                </code>
              </pre>
              <p className={styles.note}>
                <span>{target.summary}</span>
                <a href={target.docsHref}>{target.docsLabel} →</a>
              </p>
            </div>
          )
        })}
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
