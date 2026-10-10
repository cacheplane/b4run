import type { MouseEvent } from "react"
import { describe, expect, it } from "vitest"
import { readerTarget } from "./WorkbenchLayout"

/** A click whose target sits inside an element matching `a.b4-chip` with `href`, or nothing. */
function click(href: string | null, modifiers: Partial<MouseEvent<HTMLElement>> = {}) {
  const chip = href === null ? null : { getAttribute: () => href }
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: { closest: (selector: string) => (selector === "a.b4-chip" ? chip : null) },
    ...modifiers,
  } as unknown as MouseEvent<HTMLElement>
}

describe("readerTarget", () => {
  it("opens a source chip's page in the reader", () => {
    expect(
      readerTarget(click("/sources/plans/sample-lakeview-county-eop.md#5-communications")),
    ).toBe("/sources/plans/sample-lakeview-county-eop.md#5-communications")
  })
  it("leaves modified clicks, other links and non-chips to the browser", () => {
    expect(readerTarget(click("/sources/fema/x.md", { metaKey: true }))).toBeNull()
    expect(readerTarget(click("/sources/fema/x.md", { button: 1 }))).toBeNull()
    expect(readerTarget(click("https://www.fema.gov/"))).toBeNull()
    expect(readerTarget(click(null))).toBeNull()
  })
})
