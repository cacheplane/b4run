/**
 * Stick-to-bottom for a streaming transcript, as pure functions.
 *
 * The rule a reader expects from a chat: while you are at the bottom, new
 * output keeps you there; scroll up to re-read something and the transcript
 * stops pulling you down until you come back (or press "Jump to latest").
 *
 * The earlier version measured the gap after each render and followed only if
 * it was under 120 px. That fails exactly when it matters: a run appends a
 * tool card or a paragraph taller than the threshold between two renders, the
 * gap is already too big when it is measured, and the transcript stops
 * following on its own — a 6,000 px transcript left near the top mid-run.
 *
 * So "following" is STATE, decided by what the reader did, not by where the
 * content happens to have grown to:
 * - Content growing never turns following off (scrollTop does not move).
 * - Scrolling UP away from the bottom turns it off.
 * - Arriving back within the threshold turns it on again.
 * A smooth "Jump to latest" scroll only ever moves down, so it cannot turn
 * following off half-way.
 */

/** How close to the bottom still counts as "at the bottom". */
export const STICK_THRESHOLD_PX = 80

export interface ScrollMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

export function distanceFromBottom({
  scrollTop,
  scrollHeight,
  clientHeight,
}: ScrollMetrics): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight)
}

export function isNearBottom(metrics: ScrollMetrics, threshold = STICK_THRESHOLD_PX): boolean {
  return distanceFromBottom(metrics) <= threshold
}

/**
 * Whether to keep following after a scroll event. `previousTop` is the
 * scrollTop seen at the previous scroll event.
 */
export function nextFollowing(
  following: boolean,
  previousTop: number,
  metrics: ScrollMetrics,
  threshold = STICK_THRESHOLD_PX,
): boolean {
  if (isNearBottom(metrics, threshold)) return true
  // Only a move UP is the reader leaving. A downward move that has not reached
  // the bottom yet (a smooth jump in flight, or the reader scrolling back
  // down) keeps whatever the state was.
  if (metrics.scrollTop < previousTop - 1) return false
  return following
}

/** The "Jump to latest" pill shows when the reader is not following and there is something below. */
export function showJumpToLatest(following: boolean, metrics: ScrollMetrics): boolean {
  return !following && distanceFromBottom(metrics) > 0
}
