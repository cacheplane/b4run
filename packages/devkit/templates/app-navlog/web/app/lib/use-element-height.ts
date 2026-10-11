import { useCallback, useState } from "react"

export interface ElementHeightOptions {
  /**
   * The height before the element is measured, and where it never can be:
   * with no `ResizeObserver`, or no layout at all (jsdom reports 0).
   */
  readonly initial: number
  /**
   * Which way a fractional height rounds. `up` when the height is room to keep
   * clear of the element (the route bar over the map), so nothing hides under
   * its last sub-pixel; `down` when it is room to fill inside the element (the
   * legs grid in its region), so the filling never overflows by one.
   */
  readonly round: "up" | "down"
}

export interface ElementHeight<T extends Element> {
  /** Attach to the element to measure. */
  readonly ref: (element: T | null) => (() => void) | undefined
  /** The element's height in whole pixels, or `initial` until it is measured. */
  readonly height: number
}

/**
 * An element's height, kept current with a `ResizeObserver`.
 *
 * A callback ref rather than an effect over a ref object: React calls it
 * whenever the ref moves to a different element (a layout swap that renders
 * the same slot in another tree), so the observer follows the element without
 * re-attaching on every render.
 *
 * A zero height is ignored and the last one kept: a hidden element (a
 * collapsed panel, the print layout) has no height, and the space it fills or
 * leaves clear should not collapse with it.
 */
export function useElementHeight<T extends Element = HTMLDivElement>({
  initial,
  round,
}: ElementHeightOptions): ElementHeight<T> {
  const [height, setHeight] = useState(initial)
  const ref = useCallback(
    (element: T | null): (() => void) | undefined => {
      if (element === null) return undefined
      const measure = (): void => {
        const measured = element.getBoundingClientRect().height
        if (measured > 0) setHeight(round === "up" ? Math.ceil(measured) : Math.floor(measured))
      }
      measure()
      if (typeof ResizeObserver === "undefined") return undefined
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      return () => observer.disconnect()
    },
    [round],
  )
  return { ref, height }
}
