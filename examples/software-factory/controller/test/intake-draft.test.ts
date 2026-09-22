import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { acceptanceIdsOf, parseDraft } from "../src/lib/intake/draft.ts"
import { digestGeneratedTask, writeGeneratedTask } from "../src/lib/intake/generated-task.ts"
import { configureCatalog, loadTask, resetCatalogForTests } from "../src/lib/targets/catalog.ts"
import { BAD_DRAFTS, GOOD_DRAFT } from "./intake-fixtures.ts"

const WO = "wo-0123456789abcdef"
const files = (draft: Readonly<Record<string, string>>) => new Map(Object.entries(draft))
let dir = ""
afterEach(() => {
  resetCatalogForTests()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ""
})

describe("acceptanceIdsOf", () => {
  it("collects A<n>: ids at line starts, in order, once each", () => {
    expect(acceptanceIdsOf("intro\nA1: x\ntext A9: not an id\nA2: y\nA1: again\n")).toEqual([
      "A1",
      "A2",
    ])
  })
})

describe("parseDraft", () => {
  it("accepts the good draft and fills id, visible and acceptance ids", () => {
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.manifest.id).toBe(WO)
    expect(parsed.manifest.target).toBe("devkit")
    expect(parsed.checks.visible).toEqual({ runner: "vitest", assertions: [] })
    expect(parsed.checks.independent.file).toBe("checks/spawn-deadline.test.ts")
    expect(parsed.acceptanceIds).toEqual(["A1"])
    expect(parsed.checkFiles).toEqual(["checks/spawn-deadline.test.ts"])
    expect([...parsed.files.keys()].sort()).toEqual([
      "checks.json",
      "checks/spawn-deadline.test.ts",
      "spec.md",
      "task.json",
    ])
  })

  for (const [name, draft] of Object.entries(BAD_DRAFTS)) {
    it(`refuses ${name} with a reason naming the file`, () => {
      const parsed = parseDraft(files(draft), { workOrderId: WO })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.reason).toMatch(/draft\/(task\.json|spec\.md|checks\.json|checks\/)/)
      expect(parsed.blockedReason).toBe(
        name === "badTarget" ? "no_target_for_package" : "intake_invalid",
      )
    })
  }

  it("names the rule each bad draft trips", () => {
    const reason = (name: keyof typeof BAD_DRAFTS) => {
      const parsed = parseDraft(files(BAD_DRAFTS[name] ?? {}), { workOrderId: WO })
      return parsed.ok ? "" : parsed.reason
    }
    expect(reason("suppliedId")).toMatch(/draft\/task\.json.*id/)
    expect(reason("badTarget")).toMatch(/Unknown target: no-such-target/)
    expect(reason("editsTests")).toMatch(/disjoint/)
    expect(reason("acceptanceMismatch")).toMatch(/A2/)
    expect(reason("noAcceptance")).toMatch(/draft\/spec\.md.*A<n>/)
    expect(reason("visibleSupplied")).toMatch(/draft\/checks\.json.*visible/)
    expect(reason("missingCheckFile")).toMatch(/draft\/checks\/other\.test\.ts/)
    expect(reason("emptySpec")).toMatch(/draft\/spec\.md/)
  })

  it("refuses an independent assertion without an A<n>: prefix", () => {
    const checks = JSON.parse(GOOD_DRAFT["draft/checks.json"] ?? "")
    checks.independent.assertions = [...checks.independent.assertions, "a bare name"]
    const parsed = parseDraft(
      files({ ...GOOD_DRAFT, "draft/checks.json": JSON.stringify(checks) }),
      { workOrderId: WO },
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toMatch(/draft\/checks\.json.*a bare name/)
  })

  it("ignores files outside draft/ and refuses a draft with nothing under it", () => {
    const parsed = parseDraft(new Map([["repo/x", "y"]]), { workOrderId: WO })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain("draft/task.json")
    expect(parsed.blockedReason).toBe("intake_invalid")
    const withStray = parseDraft(files({ ...GOOD_DRAFT, "repo/x": "y" }), { workOrderId: WO })
    expect(withStray.ok).toBe(true)
    if (withStray.ok) expect(withStray.files.has("repo/x")).toBe(false)
  })

  it("refuses a work order id that is not a catalog id, before touching anything", () => {
    for (const workOrderId of ["../x", ".hidden", "a/b", ""]) {
      const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.reason).toContain(JSON.stringify(workOrderId))
      expect(parsed.blockedReason).toBe("intake_invalid")
    }
  })
})

describe("writeGeneratedTask", () => {
  const issueText = "# Issue 778\n\nbody\n"

  it("materialises a loadable task, deterministically digested, with the issue text", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO })
    if (!parsed.ok) throw new Error(parsed.reason)
    const first = await writeGeneratedTask(dir, parsed, { issueText })
    const second = await writeGeneratedTask(dir, parsed, { issueText })
    expect(first.digest).toBe(second.digest)
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(first.directory).toBe(join(dir, WO))
    expect(readFileSync(join(first.directory, "issue.md"), "utf8")).toBe(issueText)
    expect(first.files).toEqual([
      "checks.json",
      "checks/spawn-deadline.test.ts",
      "issue.md",
      "spec.md",
      "task.json",
    ])
    expect(digestGeneratedTask(first.directory)).toBe(first.digest)
    const manifest = readFileSync(join(first.directory, "task.json"), "utf8")
    expect(Object.keys(JSON.parse(manifest))).toEqual([
      "id",
      "target",
      "allowedSourcePaths",
      "immutablePaths",
    ])
    expect(manifest.endsWith("\n")).toBe(true)
    configureCatalog({ generatedTasksDir: dir })
    const task = loadTask(WO)
    expect(task.id).toBe(WO)
    expect(task.checks.independent.file).toBe("checks/spawn-deadline.test.ts")
    expect(task.checks.visible).toEqual({ runner: "vitest", assertions: [] })
    expect(task.specText).toBe(GOOD_DRAFT["draft/spec.md"])
    expect(task.referencePatch).toBeNull()
    expect(task.defectPatch).toBeNull()
    expect(existsSync(join(first.directory, "reference.patch"))).toBe(false)
    // No temp sibling is left behind, and nothing in the directory is listed as a task.
    expect(existsSync(join(dir, WO))).toBe(true)
    expect(readFileSync(join(first.directory, "checks.json"), "utf8")).toContain('"visible"')
  })

  it("changes the digest when any file changes, and replaces a previous attempt wholesale", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    const first = parseDraft(files(GOOD_DRAFT), { workOrderId: WO })
    if (!first.ok) throw new Error(first.reason)
    const before = await writeGeneratedTask(dir, first, { issueText })
    // A stray file from the first attempt must not survive the second.
    mkdirSync(join(before.directory, "checks"), { recursive: true })
    writeFileSync(join(before.directory, "checks", "old.test.ts"), "stale\n")
    expect(digestGeneratedTask(before.directory)).not.toBe(before.digest)
    const second = parseDraft(
      files({ ...GOOD_DRAFT, "draft/spec.md": `${GOOD_DRAFT["draft/spec.md"]}One more line.\n` }),
      { workOrderId: WO },
    )
    if (!second.ok) throw new Error(second.reason)
    const after = await writeGeneratedTask(dir, second, { issueText })
    expect(after.digest).not.toBe(before.digest)
    expect(existsSync(join(after.directory, "checks", "old.test.ts"))).toBe(false)
    expect(after.files).toEqual(before.files)
    expect(digestGeneratedTask(after.directory)).toBe(after.digest)
    // The issue text is part of what the digest binds, too.
    const otherIssue = await writeGeneratedTask(dir, second, { issueText: "# Issue 779\n" })
    expect(otherIssue.digest).not.toBe(after.digest)
  })
})
