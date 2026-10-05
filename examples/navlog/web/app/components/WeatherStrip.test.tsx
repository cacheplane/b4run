import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import type { AirportWeather } from "../lib/weather-selectors"
import { WeatherStrip } from "./WeatherStrip"

const brief = {
  airports: [
    {
      id: "KSTP",
      now: "VFR" as const,
      atEta: "VFR" as const,
      line: "VFR now, VFR at ETA",
      metar: "METAR KSTP …",
      taf: "TAF KSTP …",
    },
    {
      id: "KRST",
      now: "VFR" as const,
      atEta: "MVFR" as const,
      line: "VFR now, MVFR at ETA",
      metar: "METAR KRST …",
      taf: "TAF KRST …",
    },
  ],
  winds: ["leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z"],
  advisories: [],
  note: "",
}

describe("WeatherStrip", () => {
  test("one chip per airport, labelled by text and data-cat, worst of now and ETA", () => {
    const html = renderToStaticMarkup(<WeatherStrip brief={brief} />)
    expect(html).toContain('data-cat="VFR"')
    expect(html).toContain("KSTP VFR")
    expect(html).toContain('data-cat="MVFR"')
    expect(html).toContain("KRST VFR now, MVFR at ETA")
  })
  test("an improving airport is shown in its worse, current category", () => {
    const improving = {
      ...brief,
      airports: [
        { ...(brief.airports[1] as AirportWeather), now: "MVFR" as const, atEta: "VFR" as const },
      ],
    }
    const html = renderToStaticMarkup(<WeatherStrip brief={improving} />)
    expect(html).toContain('data-cat="MVFR"')
    expect(html).toContain("KRST MVFR now, VFR at ETA")
    expect(html).not.toContain('data-cat="VFR"')
  })
  test("the phone row scrolls sideways instead of wrapping", () => {
    const html = renderToStaticMarkup(<WeatherStrip brief={brief} layout="row" />)
    expect(html).toContain("flex-nowrap overflow-x-auto")
    expect(html).not.toContain("flex-wrap")
  })
  test("shows the first winds line and the raw reports in a disclosure", () => {
    const html = renderToStaticMarkup(<WeatherStrip brief={brief} />)
    expect(html).toContain("320/29")
    expect(html).toContain("METAR KRST …")
    expect(html).toContain("<details")
  })
  test("renders nothing without a brief", () => {
    expect(renderToStaticMarkup(<WeatherStrip brief={null} />)).toBe("")
  })
})
