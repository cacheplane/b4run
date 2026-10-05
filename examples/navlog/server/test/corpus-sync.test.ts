import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { CLIMB_TABLE, CRUISE_TABLE, LANDING_TABLE, TAKEOFF_TABLE } from "../src/lib/poh-tables.ts"

const doc = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../workspace/poh/${name}.md`, import.meta.url)), "utf8")

// The corpus writes "Sea level", then 1000 to 9000 bare and 10,000 up with a comma.
const fmtAlt = (ft: number): string =>
  ft === 0 ? "Sea level" : ft >= 10000 ? ft.toLocaleString("en-US") : String(ft)

describe("workspace/poh matches src/lib/poh-tables", () => {
  it("cruise rows", () => {
    const md = doc("cruise-performance")
    for (const row of CRUISE_TABLE) {
      const cell = (c: { bhpPct: number; tasKt: number; gph: number } | null): string =>
        c === null ? "—" : `${c.bhpPct} / ${c.tasKt} / ${c.gph.toFixed(1)}`
      const line = `| ${fmtAlt(row.pressureAltitudeFt)} | ${row.rpm} | ${cell(row.below)} | ${cell(row.standard)} | ${cell(row.above)} |`
      expect(md, line).toContain(line)
    }
  })
  it("climb rows", () => {
    const md = doc("time-fuel-distance-to-climb")
    for (const row of CLIMB_TABLE) {
      // Anchored on the altitude, so swapped rows fail.
      const pattern = new RegExp(
        `^\\| ${fmtAlt(row.pressureAltitudeFt)} \\|.*\\| ${row.timeMin} \\| ${row.fuelGal.toFixed(1).replace(".", "\\.")} \\| ${row.distanceNm} \\|$`,
        "m",
      )
      expect(md, `${row.pressureAltitudeFt}`).toMatch(pattern)
    }
  })
  it("takeoff and landing rows", () => {
    const to = doc("takeoff-distance")
    for (const row of TAKEOFF_TABLE) {
      const cells = row.byTemperature.map((c) => `${c.groundRollFt} / ${c.over50FtFt}`).join(" | ")
      expect(to).toContain(`| ${fmtAlt(row.pressureAltitudeFt)} | ${cells} |`)
    }
    const ld = doc("landing-distance")
    for (const row of LANDING_TABLE) {
      const cells = row.byTemperature.map((c) => `${c.groundRollFt} / ${c.over50FtFt}`).join(" | ")
      expect(ld).toContain(`| ${fmtAlt(row.pressureAltitudeFt)} | ${cells} |`)
    }
  })
})
