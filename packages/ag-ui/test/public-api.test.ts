import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import * as api from "../src/index.js"

it("exports only the canonical runtime adapter surface from the package root", () => {
  expect(Object.keys(api).sort()).toEqual([
    "B4_CONTENT_PARTS_DROPPED_EVENT",
    "B4_PLAN_ACTIVITY_TYPE",
    "createCounterIdFactory",
    "createDefaultIdFactory",
    "fromRunAgentInput",
    "toAguiEvents",
  ])
})

it("exports the stable activity type literal", () => {
  expect(api.B4_PLAN_ACTIVITY_TYPE).toBe("b4.plan")
  expect(api.B4_CONTENT_PARTS_DROPPED_EVENT).toBe("b4.content_parts_dropped")
})

it("matches the root surface the release smoke expects of the published package", () => {
  // The published-harness lane installs @b4run/ag-ui from npm and compares its
  // root exports to a list kept in scripts/published-artifact-smoke.mjs. That
  // lane first runs at release time, from the frozen candidate, so a stale list
  // there fails a release that cannot be fixed in place (v0.14.0). Hold the two
  // lists together here, where every pull request runs.
  const smoke = readFileSync(
    new URL("../../../scripts/published-artifact-smoke.mjs", import.meta.url),
    "utf8",
  )
  const block = /assert\.deepEqual\(Object\.keys\(root\)\.sort\(\), \[([^\]]*)\]\)/.exec(smoke)
  expect(block, "release smoke must compare the sorted root exports").not.toBeNull()
  const expected = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1])
  expect(expected).toEqual(Object.keys(api).sort())
})
