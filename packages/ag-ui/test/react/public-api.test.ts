import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import * as react from "../../src/react/index.js"

describe("@b4run/ag-ui/react public API", () => {
  test("exports the activity kit, the blocks, the hooks and the legacy cards", () => {
    expect(Object.keys(react).sort()).toEqual(
      [
        "ActivityChecklist",
        "ApprovalCard",
        "Checklist",
        "Chevron",
        "Disclosure",
        "EMPTY_SUBAGENT_RUNS",
        "PlanActivityCard",
        "PlanStep",
        "ReasoningStep",
        "SourceChips",
        "StatusText",
        "Step",
        "StepDetail",
        "StepGroup",
        "StepIcon",
        "SubagentPanel",
        "SubagentStep",
        "TurnActivity",
        "approvalPayload",
        "cx",
        "formatDuration",
        "isSubagentMessage",
        "planActivityContentSchema",
        "reduceSubagentRuns",
        "scopeLine",
        "summaryLine",
        "useDisclosure",
        "useElapsed",
        "useLive",
        "useSubagentRuns",
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
