import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  describePrecheck,
  type PrecheckRule,
  precheckDraftedCheck,
} from "../src/lib/intake/check-precheck.ts"

const FILE = "checks/runs-wait-undefined.test.ts"
const fixture = (attempt: number) => {
  const dir = join(import.meta.dirname, "fixtures", "precheck-714", `attempt-${attempt}`)
  const checks = JSON.parse(readFileSync(join(dir, "checks.json"), "utf8"))
  return {
    source: readFileSync(join(dir, "check.test.ts.txt"), "utf8"),
    file: FILE,
    assertions: checks.independent.assertions as string[],
  }
}
const rules = (violations: readonly { rule: PrecheckRule }[]) =>
  [...new Set(violations.map((v) => v.rule))].sort()

/** A check in the shape the drafter is taught: the one every rule admits. */
const GOOD = `import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

const { run } = await import(join(process.cwd(), "packages/cli/dist/index.js"))

test("A1: run answers 200", async () => {
  const dir: string = "x"
  assert.equal(await run(dir), 200)
})

test("A2: run answers JSON", async () => {
  assert.ok(true)
})
`

describe("the static pre-check", () => {
  describe("the three drafts the rerun of issue 714 refused (wo-c7cbe172b6017faf)", () => {
    it("refuses attempt 1: no node:test import, the build through ../repo, not through cwd", () => {
      // Refused live for its spec (A4 with no test); its check had these too, found only later.
      const violations = precheckDraftedCheck(fixture(1))
      expect(rules(violations)).toEqual(["cwd-artifact", "node-test-import", "relative-import"])
      expect(violations.find((v) => v.rule === "relative-import")?.line).toBe(5)
      expect(violations.find((v) => v.rule === "cwd-artifact")?.line).toBe(5)
    })

    it("refuses attempt 2, whose proof failed with ERR_MODULE_NOT_FOUND after ten minutes", () => {
      const violations = precheckDraftedCheck(fixture(2))
      expect(rules(violations)).toEqual(["cwd-artifact", "node-test-import", "relative-import"])
      expect(violations.find((v) => v.rule === "relative-import")?.detail).toContain(
        '"../repo/packages/cli/dist/runtime-exports.js"',
      )
    })

    it("refuses attempt 3, whose proof failed with `test is not defined`", () => {
      const violations = precheckDraftedCheck(fixture(3))
      // It loaded the build correctly: the one defect left is the missing import.
      expect(rules(violations)).toEqual(["node-test-import"])
      expect(describePrecheck(FILE, violations)).toContain(
        "draft/checks/runs-wait-undefined.test.ts fails the static pre-check (1 problem): [node-test-import]",
      )
    })

    it("admits attempt 3 with the import added: the rules are not stricter than the defects", () => {
      const { source, ...rest } = fixture(3)
      const mended = `import { test } from "node:test"\n${source}`
      expect(precheckDraftedCheck({ source: mended, ...rest })).toEqual([])
    })
  })

  it("admits the skeleton the drafter's system prompt teaches", () => {
    // Read as text: the controller imports no drafter source, and the two must not drift.
    const route = readFileSync(
      join(import.meta.dirname, "..", "..", "drafter", "src", "app", "intake", "index.ts"),
      "utf8",
    )
    const skeleton = /\\`\\`\\`ts\n([\s\S]*?)\\`\\`\\`/.exec(route)?.[1]?.replaceAll("\\`", "`")
    expect(skeleton).toBeDefined()
    expect(
      precheckDraftedCheck({ source: skeleton as string, file: FILE, assertions: ["A1: x"] }),
    ).toEqual([])
  })

  it("admits the skeleton shape", () => {
    expect(
      precheckDraftedCheck({ source: GOOD, file: FILE, assertions: ["A1: x", "A2: y"] }),
    ).toEqual([])
  })

  it.each([
    'import test from "node:test"',
    'import * as nt from "node:test"',
    'import { describe, test as t } from "node:test"',
  ])("accepts %s as binding test", (line) => {
    const source = GOOD.replace('import { test } from "node:test"', line).replaceAll(
      /^test\(/gm,
      line.includes("* as nt") ? "nt.test(" : "test(",
    )
    const violations = precheckDraftedCheck({ source, file: FILE, assertions: ["A1: x", "A2: y"] })
    expect(rules(violations).filter((rule) => rule === "node-test-import")).toEqual([])
  })

  it("names the line of a syntax error", () => {
    const source = GOOD.replace("assert.ok(true)", "assert.ok(")
    const violations = precheckDraftedCheck({ source, file: FILE, assertions: ["A1: x", "A2: y"] })
    expect(violations[0]).toMatchObject({ rule: "syntax" })
    expect(violations[0]?.line).toBeGreaterThan(10)
  })

  it("allows a relative specifier that stays under checks/", () => {
    const source = GOOD.replace(
      'import { test } from "node:test"',
      'import { test } from "node:test"\nimport data from "./fixture.json" with { type: "json" }',
    )
    expect(precheckDraftedCheck({ source, file: FILE, assertions: ["A1: x", "A2: y"] })).toEqual([])
  })

  it("refuses top-level tests that disagree with checks.json, by acceptance id", () => {
    const violations = precheckDraftedCheck({
      source: GOOD,
      file: FILE,
      assertions: ["A1: x", "A3: z"],
    })
    expect(rules(violations)).toEqual(["test-names"])
    expect(violations[0]?.detail).toMatch(/no test for A3: A2 not listed/)
    // Names that differ only in wording from checks.json are the same assertion.
    expect(
      precheckDraftedCheck({
        source: GOOD,
        file: FILE,
        assertions: ["A1: run answers 200 for a route.", "A2: something else"],
      }),
    ).toEqual([])
  })

  it("refuses a check with no top-level named test", () => {
    const source = GOOD.replaceAll(/^test\("A\d: /gm, 'test("')
    expect(
      rules(precheckDraftedCheck({ source, file: FILE, assertions: ["A1: x", "A2: y"] })),
    ).toEqual(["test-names"])
  })

  it("admits every shipped task's check written to the drafted-task rules", () => {
    const tasks = join(import.meta.dirname, "..", "tasks")
    // `cli-flags` predates acceptance ids (rung 0): a draft could not name its tests so.
    const drafted = readdirSync(tasks).filter((id) =>
      JSON.parse(readFileSync(join(tasks, id, "checks.json"), "utf8")).independent.assertions.every(
        (name: string) => /^A\d+:/.test(name),
      ),
    )
    expect(drafted.length).toBeGreaterThanOrEqual(2)
    for (const id of drafted) {
      const checks = JSON.parse(readFileSync(join(tasks, id, "checks.json"), "utf8"))
      const file = checks.independent.file as string
      const violations = precheckDraftedCheck({
        source: readFileSync(join(tasks, id, file), "utf8"),
        file,
        assertions: checks.independent.assertions,
      })
      expect({ id, violations }).toEqual({ id, violations: [] })
    }
  })
})
