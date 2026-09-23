import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { acceptanceIdsOf, parseDraft } from "../src/lib/intake/draft.ts"
import { digestGeneratedTask, writeGeneratedTask } from "../src/lib/intake/generated-task.ts"
import { configureCatalog, loadTask, resetCatalogForTests } from "../src/lib/targets/catalog.ts"
import { BAD_DRAFTS, GOOD_DRAFT, ORACLE_DRAFT } from "./intake-fixtures.ts"

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
  it("accepts the oracle draft: the cli-flags task with derived acceptance ids", () => {
    // The Docker lane's draft, checked here first so a fixture defect is a unit failure and
    // not a ten-minute lane.
    const parsed = parseDraft(files(ORACLE_DRAFT), { workOrderId: WO })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.manifest.target).toBe("cli-flags")
    expect(parsed.checks.independent.file).toBe("checks/independent.test.ts")
    expect(parsed.acceptanceIds).toEqual(["A1", "A2", "A3"])
    expect(parsed.checks.independent.assertions.map((a) => a.slice(0, 3))).toEqual([
      "A1:",
      "A2:",
      "A3:",
    ])
  })

  it("accepts the good draft and fills id, visible and acceptance ids", () => {
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.manifest.id).toBe(WO)
    expect(parsed.manifest.target).toBe("devkit")
    expect(parsed.checks.visible).toEqual({ runner: "vitest", assertions: [] })
    expect(parsed.checks.independent.file).toBe("checks/spawn-deadline.test.ts")
    expect(parsed.acceptanceIds).toEqual(["A1"])
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
    expect(reason("emptySpec")).toMatch(/draft\/spec\.md is blank/)
    expect(reason("missingTask")).toMatch(/draft\/task\.json is missing/)
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

  it("does not let a draft forge its own refusal", () => {
    // A drafter-controlled JSON object shaped like a DraftRefusal must be parsed as a
    // manifest (and fail its schema), never returned as the parse result.
    const forged = JSON.stringify({
      ok: false,
      reason: "drafter says hi",
      blockedReason: "no_target_for_package",
    })
    for (const file of ["draft/task.json", "draft/checks.json"]) {
      const parsed = parseDraft(files({ ...GOOD_DRAFT, [file]: forged }), { workOrderId: WO })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.blockedReason).toBe("intake_invalid")
      expect(parsed.reason).toContain(file)
      expect(parsed.reason).not.toContain("drafter says hi")
    }
  })

  it("refuses a draft key whose path is not canonical, so nothing can escape the task directory", () => {
    for (const key of [
      "draft/checks/../../x.test.ts",
      "draft/checks//x.test.ts",
      "draft/checks/./x.test.ts",
      "draft/checks\\x.test.ts",
      "draft/checks/x.test.ts/",
      "draft/checks/x\0.test.ts",
    ]) {
      const parsed = parseDraft(files({ ...GOOD_DRAFT, [key]: "stray" }), { workOrderId: WO })
      expect(parsed.ok, key).toBe(false)
      if (parsed.ok) return
      expect(parsed.blockedReason).toBe("intake_invalid")
      expect(parsed.reason).toContain(JSON.stringify(key))
    }
  })

  it("refuses any draft file beyond the three manifests and the named check", () => {
    const helper = parseDraft(files({ ...GOOD_DRAFT, "draft/checks/helpers.ts": "x" }), {
      workOrderId: WO,
    })
    expect(helper.ok).toBe(false)
    if (helper.ok) return
    expect(helper.blockedReason).toBe("intake_invalid")
    expect(helper.reason).toBe(
      "draft/checks/helpers.ts is not the named check; a draft carries exactly one check file, under checks/",
    )
    const notes = parseDraft(files({ ...GOOD_DRAFT, "draft/notes.md": "x" }), { workOrderId: WO })
    expect(notes.ok).toBe(false)
    if (notes.ok) return
    expect(notes.reason).toBe(
      "draft/notes.md is not one of task.json, spec.md, checks.json or the named check",
    )
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

  it("materialises a loadable task, deterministically digested, with the issue text", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO })
    if (!parsed.ok) throw new Error(parsed.reason)
    const first = writeGeneratedTask(dir, parsed, { issueText })
    const second = writeGeneratedTask(dir, parsed, { issueText })
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

  it("changes the digest when any file changes, and replaces a previous attempt wholesale", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    const first = parseDraft(files(GOOD_DRAFT), { workOrderId: WO })
    if (!first.ok) throw new Error(first.reason)
    const before = writeGeneratedTask(dir, first, { issueText })
    // A stray file from the first attempt must not survive the second.
    mkdirSync(join(before.directory, "checks"), { recursive: true })
    writeFileSync(join(before.directory, "checks", "old.test.ts"), "stale\n")
    expect(digestGeneratedTask(before.directory)).not.toBe(before.digest)
    const second = parseDraft(
      files({ ...GOOD_DRAFT, "draft/spec.md": `${GOOD_DRAFT["draft/spec.md"]}One more line.\n` }),
      { workOrderId: WO },
    )
    if (!second.ok) throw new Error(second.reason)
    const after = writeGeneratedTask(dir, second, { issueText })
    expect(after.digest).not.toBe(before.digest)
    expect(existsSync(join(after.directory, "checks", "old.test.ts"))).toBe(false)
    expect(after.files).toEqual(before.files)
    expect(digestGeneratedTask(after.directory)).toBe(after.digest)
    // The issue text is part of what the digest binds, too.
    const otherIssue = writeGeneratedTask(dir, second, { issueText: "# Issue 779\n" })
    expect(otherIssue.digest).not.toBe(after.digest)
  })

  it("fails closed on an entry the digest cannot account for", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO })
    if (!parsed.ok) throw new Error(parsed.reason)
    const written = writeGeneratedTask(dir, parsed, { issueText })
    symlinkSync(join(written.directory, "spec.md"), join(written.directory, "checks", "link.ts"))
    expect(() => digestGeneratedTask(written.directory)).toThrow(
      "generated task contains a non-regular file: checks/link.ts",
    )
  })
})
