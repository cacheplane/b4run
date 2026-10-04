import { type RefObject, useEffect, useRef, useState } from "react"
import type { ToolStep } from "../../view/turns.js"

/** A step settling within this window never shows its running treatment (spec §3.1). */
export const NO_FLASH_MS = 300

/**
 * The latest `value` behind a stable ref, so a timer callback reads the
 * current clock without the timer depending on the clock's identity — an
 * inline `now={() => …}` must neither re-arm a timeout nor recreate an interval.
 */
function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

/** `now()` re-sampled once a second while `active`; the last sample otherwise. */
export function useElapsed(active: boolean, now: () => number): number {
  const clock = useLatest(now)
  const [tick, setTick] = useState(() => now())
  useEffect(() => {
    setTick(clock.current())
    if (!active) return
    const id = setInterval(() => setTick(clock.current()), 1000)
    return () => clearInterval(id)
  }, [active, clock])
  return tick
}

/** Whether a tool step shows as running: running for at least `NO_FLASH_MS`. */
export function useLive(step: Pick<ToolStep, "status" | "startedAt">, now: () => number): boolean {
  const clock = useLatest(now)
  const running = step.status === "running"
  const [past, setPast] = useState(() => now() - step.startedAt >= NO_FLASH_MS)
  useEffect(() => {
    if (!running) return
    const remaining = NO_FLASH_MS - (clock.current() - step.startedAt)
    if (remaining <= 0) {
      setPast(true)
      return
    }
    setPast(false)
    const id = setTimeout(() => setPast(true), remaining)
    return () => clearTimeout(id)
  }, [running, step.startedAt, clock])
  return running && past
}
