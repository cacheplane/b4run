import { describe, expect, it } from "vitest"
import type { TargetRecipe } from "../src/lib/targets/catalog.ts"
import { measureTask } from "../src/lib/targets/measure/session.ts"

describe("the task a measurement session captures", () => {
  it("is task-shaped with no defect, and its id is a capture-safe name", () => {
    const recipe = { id: "cli.v2", pin: "a".repeat(40) } as TargetRecipe
    expect(measureTask(recipe)).toEqual({
      id: "measure-cli_v2",
      target: recipe,
      specText: `target:measure of cli.v2 at ${"a".repeat(40)}\n`,
      defectPatch: null,
    })
  })
})
