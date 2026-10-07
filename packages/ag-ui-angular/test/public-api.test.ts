import { readdirSync, readFileSync } from "node:fs"
import { reflectComponentType } from "@angular/core"
import { describe, expect, test } from "vitest"
import * as kit from "../src/index"

describe("@b4run/ag-ui-angular public API", () => {
  test("exports the activity kit, the blocks and the signal helpers", () => {
    expect(Object.keys(kit).sort()).toEqual(
      [
        "ApprovalCardComponent",
        "ChecklistComponent",
        "DisclosureComponent",
        "PlanStepComponent",
        "ReasoningStepComponent",
        "SourceChipsComponent",
        "StepComponent",
        "StepDetailComponent",
        "StepGroupComponent",
        "StepIconComponent",
        "SubagentStepComponent",
        "SvgAttrsDirective",
        "TurnActivityComponent",
        "disclosure",
        "elapsedSignal",
        "liveSignal",
      ].sort(),
    )
  })

  test("components are standalone, with the selectors the README documents", () => {
    const mirrors = Object.entries(kit).flatMap(([name, value]) => {
      const mirror = typeof value === "function" ? reflectComponentType(value as never) : null
      return mirror ? [[name, mirror] as const] : []
    })
    for (const [name, mirror] of mirrors) expect(mirror.isStandalone, name).toBe(true)
    const selectors = Object.fromEntries(mirrors.map(([name, mirror]) => [name, mirror.selector]))
    expect(selectors).toEqual({
      ApprovalCardComponent: "b4-approval-card",
      ChecklistComponent: "b4-checklist",
      DisclosureComponent: "b4-disclosure",
      PlanStepComponent: "li[b4-plan-step]",
      ReasoningStepComponent: "li[b4-reasoning-step]",
      SourceChipsComponent: "b4-source-chips",
      StepComponent: "li[b4-step]",
      StepDetailComponent: "b4-step-detail",
      StepGroupComponent: "li[b4-step-group]",
      StepIconComponent: "b4-step-icon",
      SubagentStepComponent: "li[b4-subagent-step]",
      TurnActivityComponent: "b4-turn-activity",
    })
  })

  test("imports nothing from React or CopilotKit, and every helper comes from @b4run/ag-ui/view", () => {
    const dir = `${import.meta.dirname}/../src/lib`
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, "utf8")
      expect(source, file).not.toMatch(/from "react"|@copilotkit|@b4run\/ag-ui\/react/)
      for (const [, specifier] of source.matchAll(/from "(@b4run\/[^"]+)"/g)) {
        expect(["@b4run/ag-ui", "@b4run/ag-ui/view"], file).toContain(specifier)
      }
    }
  })
})
