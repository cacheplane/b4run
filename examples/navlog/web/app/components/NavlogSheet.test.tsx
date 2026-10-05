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
    expect(html).not.toContain("<table")
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
  })
})
