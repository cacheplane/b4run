import { expect, it } from "vitest"
import * as api from "../src/index.js"

it("exports only the canonical runtime adapter surface from the package root", () => {
  expect(Object.keys(api).sort()).toEqual([
    "B4_CONTENT_PARTS_DROPPED_EVENT",
    "B4_PLAN_ACTIVITY_TYPE",
    "B4_SUBAGENT_ACTIVITY_TYPE",
    "createCounterIdFactory",
    "createDefaultIdFactory",
    "fromRunAgentInput",
    "toAguiEvents",
  ])
})

it("exports stable activity type literals", () => {
  expect(api.B4_PLAN_ACTIVITY_TYPE).toBe("b4.plan")
  expect(api.B4_SUBAGENT_ACTIVITY_TYPE).toBe("b4.subagent")
  expect(api.B4_CONTENT_PARTS_DROPPED_EVENT).toBe("b4.content_parts_dropped")
})
