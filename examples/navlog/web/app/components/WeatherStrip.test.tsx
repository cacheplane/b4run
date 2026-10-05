import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
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
    expect(html).toContain("KRST MVFR at ETA")
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
