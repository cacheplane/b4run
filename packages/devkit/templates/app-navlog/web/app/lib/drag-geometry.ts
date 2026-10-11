/**
 * The geometry of dragging a pill along the route bar: where it lands, and how
 * fast the row scrolls when the pointer nears an end. Pure, so the rules are
 * tested without a layout.
 */

/**
 * The index the pill at `from` moves to when the pointer is at `x`: one past
 * every other pill whose middle is left of the pointer. `centers` are the
 * pills' horizontal middles, measured when the drag began, and `x` is in the
 * same coordinates (the row's scrolled content), so the answer neither shifts
 * while the row redraws under the pointer nor drifts as it scrolls.
 */
export function dropIndex(x: number, centers: readonly number[], from: number): number {
  let to = 0
  for (const [index, center] of centers.entries()) {
    if (index !== from && center < x) to += 1
  }
  return to
}

/** How close to an end of the row the pointer starts it scrolling, in px. */
export const EDGE_PX = 32
/** The fastest the row scrolls, in px per frame: with the pointer at or past an end. */
export const MAX_SCROLL_PX = 10

/**
 * How far the row scrolls this frame while a pill is dragged, in px: negative
 * toward its start, positive toward its end, zero away from the ends. The
 * speed grows as the pointer nears an end, so a long route scrolls slowly at
 * first and quickly with the pointer held at the edge.
 */
export function edgeScrollSpeed(x: number, left: number, right: number): number {
  const width = right - left
  // A row narrower than both edge zones together has no middle to rest in.
  const edge = Math.min(EDGE_PX, width / 3)
  if (edge <= 0) return 0
  const depth = (into: number): number => Math.min(1, Math.max(0, 1 - into / edge))
  if (x < left + edge) return -MAX_SCROLL_PX * depth(x - left)
  if (x > right - edge) return MAX_SCROLL_PX * depth(right - x)
  return 0
}
