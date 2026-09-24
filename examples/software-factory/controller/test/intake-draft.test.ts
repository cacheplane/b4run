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
import { acceptanceIdsOf, acceptanceMismatch, parseDraft } from "../src/lib/intake/draft.ts"
import { digestGeneratedTask, writeGeneratedTask } from "../src/lib/intake/generated-task.ts"
import {
  configureCatalog,
  loadTask,
  resetCatalogForTests,
  targetsDir,
} from "../src/lib/targets/catalog.ts"
import { BAD_DRAFTS, GOOD_DRAFT, ORACLE_DRAFT } from "./intake-fixtures.ts"
import { shippedPin } from "./temp-repo.ts"

const WO = "wo-0123456789abcdef"
/** The work order's pin: the one the shipped devkit target (GOOD_DRAFT's) is prepared at. */
const PIN = shippedPin("devkit")
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
    const parsed = parseDraft(files(ORACLE_DRAFT), {
      workOrderId: WO,
      pin: shippedPin("cli-flags"),
    })
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
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO, pin: PIN })
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

  it("refuses a check that fails the static pre-check as intake_invalid, before any proof", () => {
    const check = "draft/checks/spawn-deadline.test.ts"
    const source = (GOOD_DRAFT[check] as string).replace('import test from "node:test"\n', "")
    const parsed = parseDraft(files({ ...GOOD_DRAFT, [check]: source }), {
      workOrderId: WO,
      pin: PIN,
    })
    expect(parsed).toMatchObject({ ok: false, blockedReason: "intake_invalid" })
    if (parsed.ok) return
    expect(parsed.reason).toMatch(
      /^draft\/checks\/spawn-deadline\.test\.ts fails the static pre-check \(1 problem\): \[node-test-import\]/,
    )
  })

  for (const [name, draft] of Object.entries(BAD_DRAFTS)) {
    it(`refuses ${name} with a reason naming the file`, () => {
      const parsed = parseDraft(files(draft), { workOrderId: WO, pin: PIN })
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
      const parsed = parseDraft(files(BAD_DRAFTS[name] ?? {}), { workOrderId: WO, pin: PIN })
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

  it("teaches the rule when the spec and the check disagree on acceptance ids", () => {
    // The live run: scope stated as A2, which no test can assert, refused twice with only the
    // mismatch named. The refusal now names the rule and where scope belongs.
    const parsed = parseDraft(files(BAD_DRAFTS.acceptanceMismatch ?? {}), {
      workOrderId: WO,
      pin: PIN,
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe(acceptanceMismatch(["A1", "A2"], ["A1"]))
    expect(parsed.reason).toContain(
      "draft/spec.md states [A1, A2] but the check asserts [A1] (the spec states [A2] that no assertion covers)",
    )
    expect(parsed.reason).toMatch(/every A<n> must be an observable behaviour/)
    expect(parsed.reason).toContain("top-level test named 'A<n>: ...'")
    expect(parsed.reason).toMatch(
      /state scope .* in draft\/task\.json .*not as an acceptance criterion/,
    )
    // The other direction: an assertion naming an id the spec never states.
    expect(acceptanceMismatch(["A1"], ["A1", "A3"])).toContain(
      "does not state [A3] that an assertion names",
    )
  })

  it("fills the target's runner configuration into immutablePaths, after the drafter's own", () => {
    const task = JSON.parse(GOOD_DRAFT["draft/task.json"] ?? "") as {
      immutablePaths: string[]
    }
    const runnerConfig = [
      "packages/devkit/package.json",
      "packages/devkit/vitest.config.ts",
      "packages/devkit/tsconfig.json",
      "packages/devkit/tsconfig.test.json",
      "packages/config-typescript",
    ]
    // The drafter lists none of the runner configuration, and one path it is covered by twice.
    const own = task.immutablePaths.filter((path) => !runnerConfig.includes(path))
    const draft = {
      ...GOOD_DRAFT,
      "draft/task.json": JSON.stringify({
        ...task,
        immutablePaths: [...own, "packages/devkit/tsconfig.json"],
      }),
    }
    const parsed = parseDraft(files(draft), { workOrderId: WO, pin: PIN })
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.manifest.immutablePaths).toEqual([
      ...own,
      "packages/devkit/tsconfig.json",
      "packages/devkit/package.json",
      "packages/devkit/vitest.config.ts",
      "packages/devkit/tsconfig.test.json",
      "packages/config-typescript",
    ])
  })

  it("refuses a draft whose allowed path is the runner configuration, naming every such path", () => {
    const task = JSON.parse(GOOD_DRAFT["draft/task.json"] ?? "") as Record<string, unknown>
    const draft = {
      ...GOOD_DRAFT,
      "draft/task.json": JSON.stringify({
        ...task,
        allowedSourcePaths: [
          "packages/devkit/src/testing/process.ts",
          "packages/devkit/vitest.config.ts",
          "packages/devkit/package.json",
        ],
        immutablePaths: ["packages/devkit/test"],
      }),
    }
    const parsed = parseDraft(files(draft), { workOrderId: WO, pin: PIN })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.blockedReason).toBe("intake_invalid")
    expect(parsed.reason).toMatch(/draft\/task\.json does not fit target devkit/)
    expect(parsed.reason).toContain("(2 problems)")
    expect(parsed.reason).toContain("may edit packages/devkit/vitest.config.ts")
    expect(parsed.reason).toContain("may edit packages/devkit/package.json")
  })

  it("refuses an independent assertion without an A<n>: prefix", () => {
    const checks = JSON.parse(GOOD_DRAFT["draft/checks.json"] ?? "")
    checks.independent.assertions = [...checks.independent.assertions, "a bare name"]
    const parsed = parseDraft(
      files({ ...GOOD_DRAFT, "draft/checks.json": JSON.stringify(checks) }),
      { workOrderId: WO, pin: PIN },
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
      const parsed = parseDraft(files({ ...GOOD_DRAFT, [file]: forged }), {
        workOrderId: WO,
        pin: PIN,
      })
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
      const parsed = parseDraft(files({ ...GOOD_DRAFT, [key]: "stray" }), {
        workOrderId: WO,
        pin: PIN,
      })
      expect(parsed.ok, key).toBe(false)
      if (parsed.ok) return
      expect(parsed.blockedReason).toBe("intake_invalid")
      expect(parsed.reason).toContain(JSON.stringify(key))
    }
  })

  it("fills the work order's pin, and refuses a draft that writes its own", () => {
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO, pin: PIN })
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.manifest.pin).toBe(PIN)
    const task = JSON.parse(GOOD_DRAFT["draft/task.json"] ?? "{}")
    const pinned = parseDraft(
      files({ ...GOOD_DRAFT, "draft/task.json": JSON.stringify({ ...task, pin: PIN }) }),
      { workOrderId: WO, pin: PIN },
    )
    expect(pinned.ok).toBe(false)
    if (pinned.ok) return
    expect(pinned.blockedReason).toBe("intake_invalid")
    expect(pinned.reason).toMatch(/^draft\/task\.json is invalid: .*pin/)
  })

  it("refuses a target with no image at the work order's pin as image_unprepared", () => {
    // The shipped devkit target holds one image, at PIN; this work order is pinned elsewhere.
    // A sha nothing holds is enough: the image is looked up before the pin is fetched.
    const elsewhere = "1".repeat(40)
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO, pin: elsewhere })
    expect(parsed).toEqual({
      ok: false,
      blockedReason: "image_unprepared",
      reason: `draft/task.json names target devkit, which has no image prepared at ${elsewhere}: an operator runs pnpm --filter @b4-example/software-factory-controller target:prepare devkit --pin ${elsewhere}`,
    })
  })

  it("looks the target up in the catalog it is given, at the work order's pin", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-draft-targets-"))
    const shipped = JSON.parse(readFileSync(join(targetsDir, "devkit", "target.json"), "utf8"))
    mkdirSync(join(dir, "devkit"))
    // Pin A has an image; pin B (the work order's) does not.
    writeFileSync(
      join(dir, "devkit", "target.json"),
      JSON.stringify({ ...shipped, images: { [PIN]: shipped.images[PIN] } }),
    )
    const pinB = "2".repeat(40)
    const refused = parseDraft(files(GOOD_DRAFT), {
      workOrderId: WO,
      pin: pinB,
      catalog: { targetsDir: dir },
    })
    expect(refused).toMatchObject({ ok: false, blockedReason: "image_unprepared" })
    const accepted = parseDraft(files(GOOD_DRAFT), {
      workOrderId: WO,
      pin: PIN,
      catalog: { targetsDir: dir },
    })
    expect(accepted.ok).toBe(true)
  })

  it("blocks as intake_run_failed, not a verdict on the draft, when the catalog fails the controller", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-draft-broken-"))
    const shipped = JSON.parse(readFileSync(join(targetsDir, "devkit", "target.json"), "utf8"))
    mkdirSync(join(dir, "devkit"))
    // A manifest caught mid-write (a torn file): not the drafter's fault, and not a missing target.
    writeFileSync(join(dir, "devkit", "target.json"), JSON.stringify(shipped).slice(0, 40))
    const torn = parseDraft(files(GOOD_DRAFT), {
      workOrderId: WO,
      pin: PIN,
      catalog: { targetsDir: dir },
    })
    expect(torn).toMatchObject({ ok: false, blockedReason: "intake_run_failed" })
    if (torn.ok) return
    expect(torn.reason).toMatch(/^target "devkit" could not be loaded at /)
    // A pin with an image that the repository cannot make present (no fetch allowed).
    const absent = "3".repeat(40)
    writeFileSync(
      join(dir, "devkit", "target.json"),
      JSON.stringify({ ...shipped, images: { [absent]: shipped.images[PIN] } }),
    )
    const previous = process.env.FACTORY_NO_FETCH
    process.env.FACTORY_NO_FETCH = "1"
    try {
      const unfetched = parseDraft(files(GOOD_DRAFT), {
        workOrderId: WO,
        pin: absent,
        catalog: { targetsDir: dir },
      })
      expect(unfetched).toMatchObject({ ok: false, blockedReason: "intake_run_failed" })
      if (unfetched.ok) return
      expect(unfetched.reason).toMatch(/not in the repository/)
    } finally {
      if (previous === undefined) delete process.env.FACTORY_NO_FETCH
      else process.env.FACTORY_NO_FETCH = previous
    }
    // A target with no image at all is image_unprepared: the same operator action mends it.
    const { images: _images, ...unprepared } = shipped
    writeFileSync(join(dir, "devkit", "target.json"), JSON.stringify(unprepared))
    expect(
      parseDraft(files(GOOD_DRAFT), { workOrderId: WO, pin: PIN, catalog: { targetsDir: dir } }),
    ).toMatchObject({ ok: false, blockedReason: "image_unprepared" })
  })

  it("refuses any draft file beyond the three manifests and the named check", () => {
    const helper = parseDraft(files({ ...GOOD_DRAFT, "draft/checks/helpers.ts": "x" }), {
      workOrderId: WO,
      pin: PIN,
    })
    expect(helper.ok).toBe(false)
    if (helper.ok) return
    expect(helper.blockedReason).toBe("intake_invalid")
    expect(helper.reason).toBe(
      "draft/checks/helpers.ts is not the named check; a draft carries exactly one check file, under checks/",
    )
    const notes = parseDraft(files({ ...GOOD_DRAFT, "draft/notes.md": "x" }), {
      workOrderId: WO,
      pin: PIN,
    })
    expect(notes.ok).toBe(false)
    if (notes.ok) return
    expect(notes.reason).toBe(
      "draft/notes.md is not one of task.json, spec.md, checks.json or the named check",
    )
  })

  it("ignores files outside draft/ and refuses a draft with nothing under it", () => {
    const parsed = parseDraft(new Map([["repo/x", "y"]]), { workOrderId: WO, pin: PIN })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain("draft/task.json")
    expect(parsed.blockedReason).toBe("intake_invalid")
    const withStray = parseDraft(files({ ...GOOD_DRAFT, "repo/x": "y" }), {
      workOrderId: WO,
      pin: PIN,
    })
    expect(withStray.ok).toBe(true)
    if (withStray.ok) expect(withStray.files.has("repo/x")).toBe(false)
  })

  it("refuses a work order id that is not a catalog id, before touching anything", () => {
    for (const workOrderId of ["../x", ".hidden", "a/b", ""]) {
      const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId, pin: PIN })
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
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO, pin: PIN })
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
      "pin",
      "allowedSourcePaths",
      "immutablePaths",
    ])
    expect(JSON.parse(manifest).pin).toBe(PIN)
    expect(manifest.endsWith("\n")).toBe(true)
    configureCatalog({ generatedTasksDir: dir })
    const task = loadTask(WO)
    expect(task.id).toBe(WO)
    // Loaded at the work order's pin, through the task's own manifest.
    expect(task.manifest.pin).toBe(PIN)
    expect(task.target.pin).toBe(PIN)
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
    const first = parseDraft(files(GOOD_DRAFT), { workOrderId: WO, pin: PIN })
    if (!first.ok) throw new Error(first.reason)
    const before = writeGeneratedTask(dir, first, { issueText })
    // A stray file from the first attempt must not survive the second.
    mkdirSync(join(before.directory, "checks"), { recursive: true })
    writeFileSync(join(before.directory, "checks", "old.test.ts"), "stale\n")
    expect(digestGeneratedTask(before.directory)).not.toBe(before.digest)
    const second = parseDraft(
      files({ ...GOOD_DRAFT, "draft/spec.md": `${GOOD_DRAFT["draft/spec.md"]}One more line.\n` }),
      { workOrderId: WO, pin: PIN },
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

  it("binds the pin: the same draft at another pin is another digest", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO, pin: PIN })
    if (!parsed.ok) throw new Error(parsed.reason)
    const here = writeGeneratedTask(dir, parsed, { issueText })
    const elsewhere = writeGeneratedTask(
      dir,
      { ...parsed, manifest: { ...parsed.manifest, pin: "1".repeat(40) } },
      { issueText },
    )
    expect(elsewhere.digest).not.toBe(here.digest)
    expect(elsewhere.files).toEqual(here.files)
  })

  it("fails closed on an entry the digest cannot account for", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    const parsed = parseDraft(files(GOOD_DRAFT), { workOrderId: WO, pin: PIN })
    if (!parsed.ok) throw new Error(parsed.reason)
    const written = writeGeneratedTask(dir, parsed, { issueText })
    symlinkSync(join(written.directory, "spec.md"), join(written.directory, "checks", "link.ts"))
    expect(() => digestGeneratedTask(written.directory)).toThrow(
      "generated task contains a non-regular file: checks/link.ts",
    )
  })
})
