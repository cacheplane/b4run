import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { type AdvisoryFact, advisoryLine, type Forecast, windsLine } from "../lib/forecast"
import { SAMPLE_FORECAST, SAMPLE_NAVLOG } from "../lib/test-fixtures"
import type { RouteStation } from "../lib/weather-roles"
import { WeatherTab, type WeatherTabProps } from "./WeatherTab"

const station = (id: string, alongNm: number, name: string): RouteStation => ({
  id,
  name,
  lat: 44.6,
  lon: -121.2,
  alongNm,
  offsetNm: 4,
})

const render = (overrides: Partial<WeatherTabProps> = {}): string =>
  renderToStaticMarkup(
    <WeatherTab
      forecast={SAMPLE_FORECAST}
      navlog={SAMPLE_NAVLOG}
      stations={[station("KS33", 80, "Madras Municipal")]}
      {...overrides}
    />,
  )

/** The markup of the section headed `title`, up to the next section. */
const section = (html: string, title: string): string => {
  const heading = html.indexOf(`>${title}</h3>`)
  expect(heading).toBeGreaterThan(-1)
  const end = html.indexOf("<section", heading)
  return html.slice(heading, end < 0 ? undefined : end)
}

/** The text a reader sees, tags dropped. */
const text = (html: string): string => html.replace(/<[^>]+>/g, "")

const withAirports = (airports: Forecast["airports"]): Forecast => ({
  ...SAMPLE_FORECAST,
  airports,
})
const [ORIGIN, EN_ROUTE, DESTINATION] = SAMPLE_FORECAST.airports as [
  Forecast["airports"][number],
  Forecast["airports"][number],
  Forecast["airports"][number],
]

describe("WeatherTab", () => {
  test("labelled sections in order: origin, en route, destination, winds, advisories", () => {
    const html = render()
    const titles = [...html.matchAll(/<h3 id="([^"]+)"[^>]*>([^<]+)<\/h3>/g)]
    expect(titles.map((match) => match[2])).toEqual([
      "Origin",
      "En route",
      "Destination",
      "Winds aloft",
      "Advisories",
    ])
    for (const match of titles) expect(html).toContain(`aria-labelledby="${match[1]}"`)
  })
  test("each role's card has its id, its category pill and its raw METAR and TAF", () => {
    const html = render()
    const origin = section(html, "Origin")
    expect(origin).toContain(">KPDX<")
    expect(origin).toContain('data-cat="VFR"')
    expect(origin).toMatch(
      />METAR<\/p><pre class="whitespace-pre-wrap[^"]*font-mono[^"]*">KPDX 121753Z/,
    )
    // Under its own label, the TAF drops the label's word: "TAF KPDX …" reads "KPDX …".
    expect(origin).toMatch(/>TAF<\/p><pre[^>]*>KPDX 121720Z 1218\/1324/)
    const enRoute = section(html, "En route")
    expect(enRoute).toContain(">KS33<")
    expect(enRoute).toContain("Madras Municipal")
    expect(enRoute).toContain("80 nm along")
    expect(enRoute).toContain("KS33 121755Z AUTO")
    expect(enRoute).toContain("No TAF issued")
    const destination = section(html, "Destination")
    expect(destination).toContain(">KBDN<")
    expect(destination).toContain("KBDN 121756Z")
    expect(destination).toContain("KBDN 121720Z 1218/1318")
  })
  test("the pill is the category at the airport's time, and says so when it changes", () => {
    const html = render({
      forecast: withAirports([
        ORIGIN,
        EN_ROUTE,
        { ...DESTINATION, categoryNow: "VFR", categoryAtTime: "MVFR" },
      ]),
    })
    const destination = section(html, "Destination")
    expect(destination).toContain('data-cat="MVFR"')
    expect(destination).toContain("VFR now → MVFR at 1905Z")
    // No TAF at KS33: the pill falls back to the category now.
    expect(section(html, "En route")).toContain('data-cat="VFR"')
  })
  test("cards come in the forecast's order, grouped by role", () => {
    const html = render({
      forecast: withAirports([
        ORIGIN,
        { ...EN_ROUTE, id: "KRDM", alongNm: 30 },
        EN_ROUTE,
        DESTINATION,
      ]),
    })
    const enRoute = section(html, "En route")
    expect(enRoute.indexOf("KRDM")).toBeLessThan(enRoute.indexOf("KS33"))
    expect(enRoute).toContain("30 nm along")
  })
  test("an en-route airport past either end reads near departure or near destination", () => {
    const enRoute = section(
      render({
        forecast: withAirports([
          ORIGIN,
          { ...EN_ROUTE, id: "KHIO", alongNm: 0 },
          // A station clamped to the route's end lands a mile short of the destination.
          { ...EN_ROUTE, id: "KRDM", alongNm: DESTINATION.alongNm - 1 },
          DESTINATION,
        ]),
      }),
      "En route",
    )
    expect(enRoute).toContain("near departure")
    expect(enRoute).toContain("near destination")
    expect(enRoute).not.toContain("0 nm along")
  })
  test("an airport with no METAR says so", () => {
    const html = render({ forecast: withAirports([ORIGIN, { ...EN_ROUTE, metar: null }]) })
    expect(section(html, "En route")).toContain("No METAR")
  })
  test("an empty en route says no stations are near the course", () => {
    const enRoute = section(render({ forecast: withAirports([ORIGIN, DESTINATION]) }), "En route")
    expect(enRoute).toContain("No reporting stations within 25 nm of the course.")
  })
  test("winds aloft shows exactly the forecast's one line", () => {
    const winds = section(render(), "Winds aloft")
    const line = windsLine(SAMPLE_FORECAST.winds[0] as Forecast["winds"][number])
    expect(winds).toContain(line)
    expect(winds.match(/<li/g)).toHaveLength(1)
  })
  test("advisories read as lines, the ones during the flight first", () => {
    const fzlvl = SAMPLE_FORECAST.advisories[0] as AdvisoryFact
    const sigmet: AdvisoryFact = {
      product: "SIGMET",
      hazard: "CONVECTIVE",
      lowestFt: null,
      highestFt: 29000,
      validFromUtc: "2026-10-12T12:00:00.000Z",
      validToUtc: "2026-10-12T14:00:00.000Z",
      relevance: "before-departure",
    }
    expect(section(render(), "Advisories")).toContain(advisoryLine(fzlvl))
    const both = section(
      render({ forecast: { ...SAMPLE_FORECAST, advisories: [sigmet, fzlvl] } }),
      "Advisories",
    )
    expect(both.indexOf(advisoryLine(fzlvl))).toBeLessThan(both.indexOf(advisoryLine(sigmet)))
  })
  test("a preliminary forecast names each gap", () => {
    const html = render({
      forecast: {
        ...SAMPLE_FORECAST,
        coverage: {
          preliminary: true,
          reasons: ["the KBDN TAF ends 1200Z, before the 1315Z ETA"],
        },
      },
    })
    expect(text(html)).toContain("Preliminary: the KBDN TAF ends 1200Z, before the 1315Z ETA")
    expect(text(render())).not.toContain("Preliminary")
  })
  test("with no forecast: one message and the role headings with their ids", () => {
    const html = render({ forecast: null, stations: [] })
    expect(html).toContain("No weather brief yet.")
    expect(section(html, "Origin")).toContain("KSTP")
    expect(section(html, "En route")).toContain("No reporting stations within 25 nm")
    expect(section(html, "Destination")).toContain("KRST")
    expect(html).not.toContain(">Winds aloft<")
    expect(html).not.toContain("<pre")
  })
})
