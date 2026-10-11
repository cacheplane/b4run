import type { DivIconOptions } from "leaflet"
import { describe, expect, test } from "vitest"
import { headingIcon, waypointIcon } from "./markers"

/** Stands in for Leaflet: `divIcon` hands back the options it was given. */
const L = { divIcon: (options: DivIconOptions) => options } as unknown as typeof import("leaflet")

const html = (icon: unknown): string => String((icon as DivIconOptions).html)

describe("map markers", () => {
  test("a waypoint's label carries its id and category, the dot its data-cat", () => {
    const icon = html(waypointIcon(L, "KSTP", "MVFR"))
    expect(icon).toContain('<span class="wb-wp-dot" data-cat="MVFR"></span>')
    expect(icon).toContain('<span class="wb-wp-label">KSTP <b>MVFR</b></span>')
  })
  test("an unknown category shows the id alone, and a station's dot has no category", () => {
    expect(html(waypointIcon(L, "KOWA", "UNKNOWN"))).toContain(
      '<span class="wb-wp-label">KOWA</span>',
    )
    expect(html(waypointIcon(L, "KOWA", "VFR", "station"))).toContain(
      '<span class="wb-wp-dot"></span>',
    )
  })
  test("ids and heading text are escaped, so they can never become markup", () => {
    const icon = html(waypointIcon(L, `<img src=x onerror="a">&'`, "VFR"))
    expect(icon).not.toContain("<img")
    expect(icon).toContain("&#60;img src=x onerror=&#34;a&#34;&#62;&#38;&#39;")
    const heading = html(headingIcon(L, "<b>090°</b>"))
    expect(heading).toBe('<span class="wb-hdg-label">&#60;b&#62;090°&#60;/b&#62;</span>')
  })
})
