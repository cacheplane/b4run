import { useEffect, useState } from "react"
import type { ToolStep } from "../../view/turns.js"

/** A step settling within this window never shows its running treatment (spec §3.1). */
export const NO_FLASH_MS = 300

/** `now()` re-sampled once a second while `active`; the last sample otherwise. */
export function useElapsed(active: boolean, now: () => number): number {
  const [tick, setTick] = useState(() => now())
  useEffect(() => {
    setTick(now())
    if (!active) return
    const id = setInterval(() => setTick(now()), 1000)
    return () => clearInterval(id)
  }, [active, now])
  return tick
}

/** Whether a tool step shows as running: running for at least `NO_FLASH_MS`. */
export function useLive(step: Pick<ToolStep, "status" | "startedAt">, now: () => number): boolean {
  const running = step.status === "running"
  const age = now() - step.startedAt
  const [past, setPast] = useState(age >= NO_FLASH_MS)
  useEffect(() => {
    if (!running) return
    const remaining = NO_FLASH_MS - (now() - step.startedAt)
    if (remaining <= 0) {
      setPast(true)
      return
    }
    setPast(false)
    const id = setTimeout(() => setPast(true), remaining)
    return () => clearTimeout(id)
  }, [running, step.startedAt, now])
  return running && past
}
