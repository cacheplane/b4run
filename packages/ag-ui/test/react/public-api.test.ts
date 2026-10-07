import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import * as react from "../../src/react/index.js"

describe("@b4run/ag-ui/react public API", () => {
  test("exports the activity kit, the blocks and the hooks", () => {
    expect(Object.keys(react).sort()).toEqual(
      [
        "ApprovalCard",
        "Checklist",
        "Chevron",
        "Disclosure",
        "PlanStep",
        "ReasoningStep",
        "SourceChips",
        "StatusText",
        "Step",
        "StepDetail",
        "StepGroup",
        "StepIcon",
        "SubagentStep",
        "TurnActivity",
        "approvalPayload",
        "formatDuration",
        "scopeLine",
        "summaryLine",
        "useDisclosure",
        "useElapsed",
        "useLive",
      ].sort(),
    )
  })
  test("imports nothing from CopilotKit (that belongs to ./copilotkit)", () => {
    const dir = fileURLToPath(new URL("../../src/react/", import.meta.url))
    const files = [
      ...readdirSync(dir),
      ...readdirSync(`${dir}activity`).map((f) => `activity/${f}`),
    ].filter((f) => /\.tsx?$/.test(f))
    for (const file of files)
      expect(readFileSync(`${dir}${file}`, "utf8"), file).not.toMatch(/@copilotkit/)
  })
})
