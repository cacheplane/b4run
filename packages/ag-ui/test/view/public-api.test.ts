import { expect, it } from "vitest"
import * as view from "../../src/view/index.ts"

it("exports the framework-free view surface", () => {
  expect(Object.keys(view).sort()).toEqual([
    "B4_STEP_EVENT_NAME",
    "B4_STEP_STATUSES",
    "BUILT_IN_GROUP_LABELS",
    "EMPTY_SUBAGENT_RUNS",
    "EMPTY_TURNS",
    "eventsFromState",
    "groupSteps",
    "isSubagentMessage",
    "readStepEvent",
    "reduceSubagentRuns",
    "reduceTurns",
    "stepLabel",
    "turnsFromState",
  ])
})

it("imports nothing from React", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    Promise.all(
      [
        "index.ts",
        "labels.ts",
        "subagent-runs.ts",
        "step.ts",
        "turns.ts",
        "turns-from-state.ts",
      ].map((file) => fs.readFile(new URL(`../../src/view/${file}`, import.meta.url), "utf8")),
    ),
  )
  for (const text of source) expect(text).not.toMatch(/from "react"|@copilotkit/)
})
