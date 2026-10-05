import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { NavlogTable } from "./NavlogTable"

// SAMPLE_NAVLOG is the server's computeNavlog output: a climb segment (MH 158,
// 6 min, ETA 1406Z) and a cruise segment (MH 161, GS 129), 66 nm, 33 min, 5.5 gal.
describe("NavlogTable", () => {
  test("renders one row per leg segment with three-digit headings and h:mm times", () => {
    const html = renderToStaticMarkup(<NavlogTable navlog={SAMPLE_NAVLOG} />)
    expect(html).toContain("KSTP → KRST (climb)")
    expect(html).toContain(">158<")
    expect(html).toContain(">161<")
    expect(html).toContain("0:06")
    expect(html).toContain("1406Z")
    expect(html).toContain("1433Z")
  })
  test("renders a totals row with reserve", () => {
    const html = renderToStaticMarkup(<NavlogTable navlog={SAMPLE_NAVLOG} />)
    expect(html).toContain("Totals")
    expect(html).toContain(">66<")
    expect(html).toContain("0:33")
    expect(html).toContain("5.5")
  })
  test("marks each row with its leg index for map highlighting", () => {
    const html = renderToStaticMarkup(<NavlogTable navlog={SAMPLE_NAVLOG} />)
    expect(html).toContain('data-leg="0"')
    expect(html).toContain('data-leg="1"')
  })
  test("phone cards carry the same numbers", () => {
    const html = renderToStaticMarkup(<NavlogTable navlog={SAMPLE_NAVLOG} variant="cards" />)
    expect(html).toContain("KSTP → KRST (cruise)")
    expect(html).toContain("129")
    expect(html).not.toContain("<table")
  })
})
