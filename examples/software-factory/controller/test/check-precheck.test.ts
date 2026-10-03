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
import { spawnSync } from "node:child_process"
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

  describe("what the rules do not read", () => {
    const check = (
      source: string,
      extra: Partial<Parameters<typeof precheckDraftedCheck>[0]> = {},
    ) => precheckDraftedCheck({ source, file: FILE, assertions: ["A1: x", "A2: y"], ...extra })

    it("a dist path in a comment, an assertion message, or a spawned argv", () => {
      const source = GOOD.replace(
        "assert.ok(true)",
        [
          "// the build lives at packages/cli/dist/index.js",
          'assert.ok(true, "see packages/cli/dist/index.js")',
          'spawnSync(process.execPath, ["packages/cli/dist/bin.js"], { encoding: "utf8" })',
        ].join("\n  "),
      )
      expect(check(source)).toEqual([])
    })

    it("a root variable holding the working directory", () => {
      const source = GOOD.replace(
        'await import(join(process.cwd(), "packages/cli/dist/index.js"))',
        'await import(join(root, "packages/cli/dist/index.js"))',
      ).replace("const { run }", "const root = process.cwd()\nconst { run }")
      expect(check(source)).toEqual([])
    })

    it("`it` as well as `test`, named or through a namespace", () => {
      const named = GOOD.replace(
        'import { test } from "node:test"',
        'import { it } from "node:test"',
      ).replaceAll(/^test\(/gm, "it(")
      expect(check(named)).toEqual([])
      const namespaced = GOOD.replace(
        'import { test } from "node:test"',
        'import * as nt from "node:test"',
      ).replaceAll(/^test\(/gm, "nt.it(")
      expect(check(namespaced)).toEqual([])
    })

    it("syntax, when the target runs its checks under a loader", () => {
      const broken = GOOD.replace("assert.ok(true)", "assert.ok(")
      expect(rules(check(broken))).toContain("syntax")
      expect(rules(check(broken, { skipSyntax: true }))).not.toContain("syntax")
    })

    it("rethrows what the stripper throws that is not a syntax error", () => {
      expect(() => check(42 as unknown as string)).toThrow()
    })
  })

  describe("the shapes that cannot load the repair", () => {
    const check = (
      source: string,
      extra: Partial<Parameters<typeof precheckDraftedCheck>[0]> = {},
    ) => precheckDraftedCheck({ source, file: FILE, assertions: ["A1: x", "A2: y"], ...extra })

    it.each(['import type { test } from "node:test"', 'import { type test } from "node:test"'])(
      "a type-only import of test: %s",
      (line) => {
        const violations = check(GOOD.replace('import { test } from "node:test"', line))
        expect(rules(violations)).toEqual(["node-test-import"])
      },
    )

    it.each(['import { run as r } from "@b4run/cli"', 'import "@b4run/cli/runtime"'])(
      "a bare import of the package under repair: %s",
      (line) => {
        const source = GOOD.replace(
          'import { join } from "node:path"',
          `import { join } from "node:path"\n${line}`,
        )
        expect(rules(check(source, { ownPackage: "@b4run/cli" }))).toEqual(["own-package-import"])
        // Another package of the repository is not the one under repair.
        expect(check(source, { ownPackage: "@b4run/devkit" })).toEqual([])
      },
    )

    it("an absolute /workspace/ location", () => {
      const source = GOOD.replace(
        'await import(join(process.cwd(), "packages/cli/dist/index.js"))',
        'await import("/workspace/packages/cli/dist/index.js")',
      )
      expect(rules(check(source))).toEqual(["absolute-path", "cwd-artifact"])
    })
  })
})
