import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { type Navlog, type NavlogWaypoint, SAMPLE_NAVLOG } from "../lib/navlog-types"
import type { RouteStation } from "../lib/weather-roles"
import type { WeatherBrief } from "../lib/weather-selectors"
import { WeatherTab, type WeatherTabProps } from "./WeatherTab"

const FZLVL = "G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight"
const SIGMET = "SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | expires before departure"
const WINDS = "leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z"

const brief: WeatherBrief = {
  airports: [
    {
      id: "KSTP",
      now: "VFR",
      atEta: "VFR",
      line: "VFR now, VFR at ETA",
      metar: "METAR KSTP 061353Z 32012KT 10SM CLR 08/M02 A3012",
      taf: "TAF KSTP 061130Z 0612/0712 32012KT P6SM SKC",
    },
    {
      id: "KRST",
      now: "VFR",
      atEta: "MVFR",
      line: "VFR now, MVFR at ETA",
      metar: "METAR KRST 061354Z 31015G22KT 10SM BKN045 06/M03 A3010",
      taf: "TAF KRST 061130Z 0612/0712 31015KT P6SM BKN025",
    },
    {
      id: "KHCD",
      now: "VFR",
      atEta: "VFR",
      line: "VFR now, VFR at ETA",
      metar: "METAR KHCD 061355Z AUTO 32010KT 10SM CLR 07/M02 A3011",
      taf: "",
    },
  ],
  winds: [WINDS],
  advisories: [FZLVL, SIGMET],
  note: "",
  horizon:
    "Departure is 37 hours out; TAFs and winds aloft do not reach it yet, so this brief is preliminary.",
}

const station = (id: string, alongNm: number, name: string): RouteStation => ({
  id,
  name,
  lat: 44.5,
  lon: -92.9,
  alongNm,
  offsetNm: 4,
})

const render = (overrides: Partial<WeatherTabProps> = {}): string =>
  renderToStaticMarkup(
    <WeatherTab
      weather={brief}
      navlog={SAMPLE_NAVLOG}
      stations={[station("KHCD", 24, "Hutchinson Municipal"), station("KOWA", 40, "Owatonna")]}
      cruiseFt={4500}
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

describe("WeatherTab", () => {
  test("labelled sections in order: origin, en route, destination, winds, advisories, horizon", () => {
    const html = render()
    const titles = [...html.matchAll(/<h3 id="([^"]+)"[^>]*>([^<]+)<\/h3>/g)]
    expect(titles.map((match) => match[2])).toEqual([
      "Origin",
      "En route",
      "Destination",
      "Winds aloft",
      "Advisories",
      "Forecast horizon",
    ])
    for (const match of titles) expect(html).toContain(`aria-labelledby="${match[1]}"`)
  })
  test("each card has its id, its category now → at ETA, and its METAR and TAF", () => {
    const html = render()
    const destination = section(html, "Destination")
    expect(destination).toContain(">KRST<")
    expect(destination).toContain('data-cat="MVFR"')
    expect(destination).toContain("VFR now → MVFR at ETA")
    expect(destination).toMatch(
      />METAR<\/p><pre class="whitespace-pre-wrap[^"]*font-mono[^"]*">KRST/,
    )
    expect(destination).toMatch(/>TAF<\/p><pre[^>]*>KRST 061130Z/)
    const origin = section(html, "Origin")
    expect(origin).toContain('data-cat="VFR"')
    expect(origin).toContain("KSTP 061353Z")
  })
  test("en route lists stations with their name and distance along, in order", () => {
    const enRoute = section(render(), "En route")
    expect(enRoute).toContain("Hutchinson Municipal")
    expect(enRoute).toContain("24 nm along")
    expect(enRoute).toContain("40 nm along")
    expect(enRoute.indexOf("KHCD")).toBeLessThan(enRoute.indexOf("KOWA"))
  })
  test("a station the brief does not cover says so", () => {
    const enRoute = section(render(), "En route")
    const owatonna = enRoute.slice(enRoute.indexOf("KOWA"))
    expect(owatonna).toContain("No report in the brief")
  })
  test("intermediate airport waypoints are en route; navaids are not", () => {
    const via: Navlog = {
      ...SAMPLE_NAVLOG,
      waypoints: [
        SAMPLE_NAVLOG.waypoints[0] as NavlogWaypoint,
        { ...(SAMPLE_NAVLOG.waypoints[0] as NavlogWaypoint), id: "KHCD" },
        { ...(SAMPLE_NAVLOG.waypoints[0] as NavlogWaypoint), id: "ODI", kind: "navaid" },
        SAMPLE_NAVLOG.waypoints[1] as NavlogWaypoint,
      ],
    }
    const enRoute = section(render({ navlog: via, stations: [] }), "En route")
    expect(enRoute).toContain(">KHCD<")
    expect(enRoute).not.toContain("ODI")
  })
  test("a station past either end reads near departure or near destination", () => {
    const enRoute = section(
      render({
        stations: [
          station("KMSP", 0, "Minneapolis"),
          // The server's great-circle length runs a mile short of the navlog's total.
          station("KDCY", SAMPLE_NAVLOG.totals.distanceNm - 1, "Dodge Center"),
        ],
      }),
      "En route",
    )
    expect(enRoute).toContain("near departure")
    expect(enRoute).toContain("near destination")
    expect(enRoute).not.toContain("0 nm along")
  })

  test("an empty en route says no stations are near the course", () => {
    const enRoute = section(render({ stations: [] }), "En route")
    expect(enRoute).toContain("No reporting stations within 25 nm of the course.")
  })
  test("winds aloft lists each leg's line", () => {
    const winds = section(render(), "Winds aloft")
    expect(winds).toContain(WINDS)
    expect(section(render({ weather: { ...brief, winds: [] } }), "Winds aloft")).toContain(
      "No winds in the brief",
    )
  })
  test("advisories render as hazard chips, the outside-window ones as one chip", () => {
    const advisories = section(render(), "Advisories")
    expect(advisories).toContain('class="wb-hazard"')
    expect(advisories).toContain("Freezing level 4,000 ft")
    expect(advisories).toContain("1 outside the flight window")
    expect(advisories).not.toContain("<span>SIGMET Convective")
  })
  test("the forecast horizon shows when the brief has one", () => {
    expect(section(render(), "Forecast horizon")).toContain('class="wb-horizon ')
    const { horizon: _horizon, ...noHorizon } = brief
    expect(render({ weather: noHorizon })).not.toContain(">Forecast horizon<")
  })
  test("with no brief: one message and the role headings with their ids", () => {
    const html = render({ weather: null, stations: [] })
    expect(html).toContain("No weather brief yet.")
    expect(section(html, "Origin")).toContain("KSTP")
    expect(section(html, "En route")).toContain("No reporting stations within 25 nm")
    expect(section(html, "Destination")).toContain("KRST")
    expect(html).not.toContain(">Winds aloft<")
    expect(html).not.toContain("<pre")
  })
})
