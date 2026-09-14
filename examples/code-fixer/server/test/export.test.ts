import { expect, it } from "vitest"
import { assertExportable } from "../src/blueprint/evidence.ts"

it("refuses replay, failed, dirty, or incomplete successful recordings", () => {
  for (const value of [{}, { mode: "replay", passed: true }, { mode: "live", passed: false }])
    expect(() => assertExportable(value)).toThrow()
})
