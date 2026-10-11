/**
 * Where a dragged pill lands: its final index in the route, read from where
 * the pointer is over the row. Pure, so the rule is tested without a layout.
 */

/**
 * The index the pill at `from` moves to when the pointer is at `x`: one past
 * every other pill whose middle is left of the pointer. `centers` are the
 * pills' horizontal middles, measured when the drag began, so the answer does
 * not shift while the row redraws under the pointer.
 */
export function dropIndex(x: number, centers: readonly number[], from: number): number {
  let to = 0
  for (const [index, center] of centers.entries()) {
    if (index !== from && center < x) to += 1
  }
  return to
}
