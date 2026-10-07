/** The activity kit's two clocks (spec §3.1), framework-free so both kits keep the same time. */

/** A step settling within this window never shows its running treatment (spec §3.1). */
export const NO_FLASH_MS = 300

/** How often a live turn's elapsed time is re-sampled. */
export const ELAPSED_TICK_MS = 1000

/**
 * Milliseconds until a step started at `startedAt` may show its running
 * treatment, at time `now`; 0 once it may.
 */
export function noFlashRemaining(startedAt: number, now: number): number {
  return Math.max(0, NO_FLASH_MS - (now - startedAt))
}

/**
 * Samples `now()` into `onSample` immediately and then once a second until the
 * returned function stops it. The summary line's elapsed time ticks on this.
 */
export function sampleElapsed(now: () => number, onSample: (time: number) => void): () => void {
  onSample(now())
  const id = setInterval(() => onSample(now()), ELAPSED_TICK_MS)
  return () => clearInterval(id)
}
