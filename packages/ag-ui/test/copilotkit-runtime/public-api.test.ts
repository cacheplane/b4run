import { describe, expect, test } from "vitest"
import * as copilotkitRuntime from "../../src/copilotkit-runtime/index.js"

describe("@b4run/ag-ui/copilotkit-runtime public API", () => {
  test("exports the runner factory and the identity-forwarding fetch", () => {
    expect(Object.keys(copilotkitRuntime).sort()).toEqual([
      "createB4AgentRunner",
      "forwardIdentity",
    ])
  })
})
