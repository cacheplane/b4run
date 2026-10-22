/**
 * Visible-time accounting for the engagement signal.
 *
 * PostHog derives `session_duration` from `max(timestamp) - min(timestamp)`
 * across a session's events, and posthog-js fires `$pageleave` only from its
 * `pagehide`/`unload` handler, never on `visibilitychange`. A visitor who
 * lands, reads, clicks nothing and leaves the tab open emits one event,
 * records a duration of zero, and is scored as a bounce.
 *
 * This module makes the recorded duration match the real one. That only holds
 * while it counts visible time and nothing else: wall clock accrued in a
 * hidden background tab is not engagement, and counting it would inflate the
 * metric instead of correcting it. `setVisible` keeps that distinction, so it
 * is not an optimisation to be dropped.
 *
 * Deliberately framework-free so it can be tested without React, fake timers,
 * or a DOM. The caller supplies the clock and drives `tick`.
 */

/**
 * 10s matches PostHog's own bounce cutoff (`session_duration >= 10s`), so a
 * reader who never clicks stops being recorded as a zero-second visit. 30s is
 * the "actually read something" signal. Two events per page view at most (the island restarts the clock on every pathname change).
 */
export const ENGAGED_TIME_THRESHOLDS_MS = [10_000, 30_000] as const

export type EngagedTime = {
  /** Report a visibility transition. Hidden time is never counted. */
  setVisible(visible: boolean): void
  /** Re-evaluate accumulated time and fire any newly crossed thresholds. */
  tick(): void
  /** Milliseconds the page has been visible so far. */
  visibleMs(): number
  /** True once every threshold has fired and ticking is pointless. */
  isComplete(): boolean
}

export type EngagedTimeOptions = {
  /** Called once per threshold, with the threshold in milliseconds. */
  onThreshold: (thresholdMs: number) => void
  /** Monotonic-enough clock. Production passes `Date.now`. */
  now: () => number
  /** Whether the page is visible at construction time. */
  startVisible: boolean
  thresholdsMs?: readonly number[]
}

export function createEngagedTimeTracker({
  onThreshold,
  now,
  startVisible,
  thresholdsMs = ENGAGED_TIME_THRESHOLDS_MS,
}: EngagedTimeOptions): EngagedTime {
  let accumulatedMs = 0
  // Timestamp the current visible run began, or null while hidden. Elapsed
  // time is derived from this rather than counted per tick, so a throttled
  // background interval cannot under-report a genuinely visible page.
  let visibleSince: number | null = startVisible ? now() : null
  const fired = new Set<number>()

  function currentVisibleMs(): number {
    return visibleSince === null ? accumulatedMs : accumulatedMs + (now() - visibleSince)
  }

  return {
    setVisible(visible: boolean) {
      if (visible) {
        // Already visible: re-asserting must not restart the run and
        // silently discard the elapsed time.
        if (visibleSince === null) visibleSince = now()
        return
      }
      if (visibleSince !== null) {
        accumulatedMs += now() - visibleSince
        visibleSince = null
      }
    },

    tick() {
      const elapsed = currentVisibleMs()
      for (const threshold of thresholdsMs) {
        if (elapsed >= threshold && !fired.has(threshold)) {
          fired.add(threshold)
          onThreshold(threshold)
        }
      }
    },

    visibleMs: currentVisibleMs,

    isComplete() {
      return fired.size === thresholdsMs.length
    },
  }
}
