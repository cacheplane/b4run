import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

/**
 * GSAP for the homepage demos. Import it only from `"use client"` islands under
 * `homepage/`; server components never touch it.
 */
export { gsap, ScrollTrigger }

/** The visitor asked for less motion: show final states at once. */
export const REDUCE = "(prefers-reduced-motion: reduce)"
/** Motion is fine. */
export const FULL = "(prefers-reduced-motion: no-preference)"
/**
 * Where the folder tour pins: wide enough for the tree beside the panel, and
 * tall enough that the tallest stop fits under the header.
 */
export const DESKTOP = "(min-width: 960px) and (min-height: 700px)"

/** Which named queries match, keyed as they were passed to `withMotion`. */
export type MotionConditions = Readonly<Record<string, boolean>>
export type MotionCleanup = () => void

export interface MotionSetup {
  /** Reduced motion: put everything in its final state; start no tweens. */
  readonly reduce: (conditions: MotionConditions) => MotionCleanup | undefined
  /** Motion allowed. */
  readonly full: (conditions: MotionConditions) => MotionCleanup | undefined
}

let registered = false

/** Registers ScrollTrigger once, and only in a browser. Returns whether it can run. */
export function registerScrollTrigger(): boolean {
  if (typeof window === "undefined") return false
  if (!registered) {
    gsap.registerPlugin(ScrollTrigger)
    registered = true
  }
  return true
}

/**
 * Runs `setup.reduce` or `setup.full` for the visitor's motion preference, inside
 * a `gsap.matchMedia()` scoped to `scope`, and runs it again whenever the
 * preference or one of `queries` changes. Tweens and ScrollTriggers a branch
 * creates synchronously are reverted on each change and by the returned
 * cleanup, which a React effect returns.
 */
export function withMotion(
  scope: Element,
  setup: MotionSetup,
  queries: Readonly<Record<string, string>> = {},
): MotionCleanup {
  if (!registerScrollTrigger()) return () => undefined
  const media = gsap.matchMedia(scope)
  media.add({ ...queries, reduce: REDUCE, full: FULL }, (context) => {
    // gsap updates this object in place on every change; hand out a snapshot.
    const conditions: MotionConditions = { ...context.conditions }
    return conditions.reduce ? setup.reduce(conditions) : setup.full(conditions)
  })
  return () => media.revert()
}
