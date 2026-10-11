import { describe, expect, test } from "vitest"
import { advisoryLabel, advisorySeverity, parseAdvisory, partitionAdvisories } from "./advisories"

describe("advisories", () => {
  test("parses the field form", () => {
    expect(
      parseAdvisory(
        "G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight",
      ),
    ).toEqual({
      product: "G-AIRMET",
      hazard: "FZLVL",
      altitudes: "freezing level 4,000 ft",
      valid: "2100Z–0300Z 07",
      relevance: "during flight",
      lowestFt: 4000,
      raw: "G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight",
    })
    const sigmet = parseAdvisory(
      "SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | expires before departure",
    )
    expect(sigmet.relevance).toBe("expires before departure")
    expect(sigmet.lowestFt).toBe(29000)
  })
  test("a free-text advisory keeps its text and has no relevance", () => {
    const free = parseAdvisory("AIRMET Sierra for mountain obscuration north of the route")
    expect(free.relevance).toBeNull()
    expect(free.raw).toBe("AIRMET Sierra for mountain obscuration north of the route")
  })
  test("severity: during flight is amber, red for icing or convection at or below cruise, else muted", () => {
    const fz = parseAdvisory(
      "G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight",
    )
    expect(advisorySeverity(fz, 5500)).toBe("warn")
    const ice = parseAdvisory(
      "G-AIRMET ICE | 3,000 ft to FL180 | valid 2100Z–0300Z 07 | during flight",
    )
    expect(advisorySeverity(ice, 5500)).toBe("danger")
    expect(advisorySeverity(ice, 2500)).toBe("warn")
    const later = parseAdvisory(
      "SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | starts after arrival",
    )
    expect(advisorySeverity(later, 5500)).toBe("muted")
    expect(advisorySeverity(parseAdvisory("something vague"), 5500)).toBe("muted")
  })
  test("labels read as words", () => {
    expect(
      advisoryLabel(
        parseAdvisory(
          "G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight",
        ),
      ),
    ).toBe("Freezing level 4,000 ft")
    expect(
      advisoryLabel(
        parseAdvisory(
          "SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | expires before departure",
        ),
      ),
    ).toBe("SIGMET Convective tops FL290")
  })
})

describe("partitionAdvisories", () => {
  const line = (text: string) => parseAdvisory(text)
  test("collapses repeats and moves advisories outside the flight window out of the way", () => {
    const { relevant, outside } = partitionAdvisories(
      [
        line("G-AIRMET ICE | 11,000–17,000 ft | valid 0000Z–0300Z 06 | expires before departure"),
        line("G-AIRMET ICE | 11,000–17,000 ft | valid 0300Z–0600Z 06 | expires before departure"),
        line("G-AIRMET FZLVL | freezing level 4,000 ft | valid 1200Z–1800Z 06 | during flight"),
        line("SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | expires before departure"),
      ],
      5500,
    )
    expect(relevant.map((a) => a.hazard)).toEqual(["FZLVL"])
    expect(outside.map((a) => a.hazard)).toEqual(["ICE", "CONVECTIVE"])
  })
  test("keeps an advisory with no relevance (an older brief) on its own chip", () => {
    const { relevant, outside } = partitionAdvisories([line("Freezing level near 4,000 ft")])
    expect(relevant).toHaveLength(1)
    expect(outside).toHaveLength(0)
  })
})
