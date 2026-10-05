import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { NavlogSheet } from "./NavlogSheet"

describe("NavlogSheet", () => {
  test("collapsed shows the totals line and the actions", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief="VFR all the way."
        open={false}
        onToggle={() => {}}
      />,
    )
    expect(html).toContain("KSTP → KRST")
    expect(html).toContain("66 nm")
    expect(html).toContain("0:33")
    expect(html).toContain("5.5 gal")
    expect(html).toContain("6:20 reserve")
    expect(html).toContain("Print")
    expect(html).toContain("Copy FPL")
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain("Show navlog")
  })
  test("collapsed keeps the body in the DOM, hidden on screen but printed", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet navlog={SAMPLE_NAVLOG} brief="" open={false} onToggle={() => {}} />,
    )
    expect(html).toContain("<table")
    expect(html).toMatch(/class="wb-sheet-body[^"]*hidden print:block"/)
  })
  test("open shows the table, the flight plan and the brief", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief="VFR all the way."
        open={true}
        onToggle={() => {}}
      />,
    )
    expect(html).toContain("<table")
    expect(html).toContain("7 Aircraft ID")
    expect(html).toContain("VFR all the way.")
    expect(html).not.toContain("hidden print:block")
  })
  test("warns when the reserve is short", () => {
    const thirsty = {
      ...SAMPLE_NAVLOG,
      totals: { ...SAMPLE_NAVLOG.totals, reserveOk: false, reserveMin: 20 },
    }
    const html = renderToStaticMarkup(
      <NavlogSheet navlog={thirsty} brief="" open={false} onToggle={() => {}} />,
    )
    expect(html).toContain("Reserve under 45 min")
  })
  test("is a disclosure with aria-expanded", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet navlog={SAMPLE_NAVLOG} brief="" open={true} onToggle={() => {}} />,
    )
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain("Hide navlog")
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1]
    expect(controls).toBeDefined()
    expect(html).toContain(`id="${controls}"`)
  })
  test("on the phone tab the totals are plain text, not a toggle", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief=""
        open={true}
        onToggle={() => {}}
        variant="cards"
        collapsible={false}
      />,
    )
    expect(html).not.toContain("aria-expanded")
    expect(html).toContain("66 nm")
    expect(html).not.toContain("hidden print:block")
  })
})
