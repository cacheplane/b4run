import { describe, expect, test } from "vitest"
import * as copilotkit from "../../src/copilotkit/index.js"

describe("@b4run/ag-ui/copilotkit public API", () => {
  test("exports the connector and the moved renderers", () => {
    expect(Object.keys(copilotkit).sort()).toEqual(
      [
        "B4Activity",
        "b4ActivityRenderers",
        "b4PlanActivityRenderer",
        "mergeTurnMessages",
        "useB4ActivityContext",
        "useB4ChatSlots",
        "useB4Turns",
      ].sort(),
    )
  })
})
