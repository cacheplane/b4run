import { describe, expect, test } from "vitest"
import * as copilotkit from "../../src/copilotkit/index.js"

describe("@b4run/ag-ui/copilotkit public API", () => {
  test("exports the connector", () => {
    expect(Object.keys(copilotkit).sort()).toEqual(
      [
        "B4Activity",
        "mergeTurnMessages",
        "useB4ActivityContext",
        "useB4ChatSlots",
        "useB4Turns",
      ].sort(),
    )
  })
})
