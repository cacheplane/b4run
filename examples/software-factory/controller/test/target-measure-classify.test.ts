import { describe, expect, it } from "vitest"
import {
  captureOmissions,
  changedPaths,
  classifyFile,
  EXCLUDED,
  errorLines,
  MeasureError,
  type Measurement,
  outputTail,
  proposeResources,
  renderMeasurementRecord,
  renderReport,
  settleFile,
  settleResources,
  type VitestRun,
} from "../src/lib/targets/measure/classify.ts"

const MiB = 1024 * 1024
const LIMITS = { fileTimeoutMs: 180_000, memoryMb: 4096 }
const COUNTS = { passed: 3, failed: 0, skipped: 0 }
const run = (overrides: Partial<VitestRun> = {}): VitestRun => ({
  exitCode: 0,
  output: "\u001b[32m✓\u001b[0m test/a.test.ts (3 tests)\n",
  timedOut: false,
  files: [{ file: "test/a.test.ts", passed: true, tests: COUNTS }],
  ms: 1_234,
  ...overrides,
})
const failing = (output: string): VitestRun =>
  run({
    exitCode: 1,
    output,
    files: [{ file: "test/a.test.ts", passed: false, tests: { passed: 0, failed: 2, skipped: 1 } }],
  })

describe("a file run alone", () => {
  it("passes when it passes and leaves the workspace as it found it", () => {
    expect(classifyFile("test/a.test.ts", run(), [], LIMITS)).toEqual({
      file: "test/a.test.ts",
      verdict: "pass",
      reason: "passes run alone",
      output: "",
      ms: 1_234,
      changed: [],
      tests: COUNTS,
      omissions: [],
    })
  })

  it("is proposed for exclusion when it fails, hangs, is killed or writes, with its output", () => {
    expect(
      classifyFile("test/a.test.ts", failing("AssertionError: nope\n"), [], LIMITS),
    ).toMatchObject({
      verdict: "fail",
      reason: "fails run alone (exit 1)",
      output: "AssertionError: nope",
      tests: { passed: 0, failed: 2, skipped: 1 },
    })
    expect(
      classifyFile(
        "test/a.test.ts",
        run({ exitCode: 124, timedOut: true, files: null }),
        [],
        LIMITS,
      ),
    ).toMatchObject({
      verdict: "hang",
      reason: "did not finish within 180000 ms run alone",
    })
    expect(
      classifyFile("test/a.test.ts", run({ exitCode: 137, files: null }), [], LIMITS),
    ).toMatchObject({
      verdict: "killed",
      reason: "was killed (exit 137; the session's memory limit was 4096 MB)",
    })
    const writes = classifyFile("test/a.test.ts", run(), ["packages/app/test/out.json"], LIMITS)
    expect(writes.verdict).toBe("writes")
    expect(writes.reason).toBe(
      "passes, but changes the workspace, which the verifier refuses as tampering: packages/app/test/out.json",
    )
  })

  it("reports what a failing file changed too, and names a capture omission", () => {
    const output =
      "Error: ENOENT: no such file or directory, open '/workspace/packages/devkit/templates/app-basic/AGENTS.md'\n"
    const result = classifyFile(
      "test/a.test.ts",
      failing(output),
      ["packages/app/test/out.json"],
      LIMITS,
      (path) => path === "packages/devkit/templates/app-basic/AGENTS.md",
    )
    expect(result.verdict).toBe("fail")
    expect(result.changed).toEqual(["packages/app/test/out.json"])
    expect(result.omissions).toEqual(["packages/devkit/templates/app-basic/AGENTS.md"])
    expect(result.reason).toBe(
      "fails run alone (exit 1); it also changed the workspace: packages/app/test/out.json; capture omission: packages/devkit/templates/app-basic/AGENTS.md exist(s) at the pin but not in the capture",
    )
    expect(captureOmissions(output, () => false)).toEqual([])
    expect(captureOmissions("ENOENT: open '/tmp/x'\n", () => true)).toEqual([])
  })

  it("is a harness error, never an exclude, when the run did not select exactly that file", () => {
    expect(() =>
      classifyFile(
        "test/a.test.ts",
        run({
          files: [
            { file: "test/x/test/a.test.ts", passed: true, tests: COUNTS },
            { file: "test/a.test.ts", passed: true, tests: COUNTS },
          ],
        }),
        [],
        LIMITS,
      ),
    ).toThrow(MeasureError)
    expect(() =>
      classifyFile("test/a.test.ts", run({ files: [], exitCode: 1 }), [], LIMITS),
    ).toThrow(/must select exactly this file/)
    expect(() =>
      classifyFile("test/a.test.ts", run({ files: null, exitCode: 2 }), [], LIMITS),
    ).toThrow(/wrote no report/)
  })

  it("settles two runs: a disagreement is flaky, never excluded", () => {
    const first = classifyFile("test/a.test.ts", failing("Error: once\n"), [], LIMITS)
    const pass = classifyFile("test/a.test.ts", run(), [], LIMITS)
    expect(settleFile(first, pass)).toMatchObject({
      verdict: "flaky",
      reason:
        "fails run alone (exit 1) on its first run, but passed a second run in a fresh container: listed, not excluded",
    })
    expect(settleFile(first, first)).toMatchObject({
      verdict: "fail",
      reason: "fails run alone (exit 1) (a second run in a fresh container: fail)",
    })
    expect(settleFile(pass, first)).toBe(pass)
    expect(EXCLUDED.has("flaky")).toBe(false)
    expect([...EXCLUDED].sort()).toEqual(["fail", "hang", "killed", "writes"])
  })

  it("keeps what either run changed or could not find, whichever verdict it settles on", () => {
    const first = classifyFile("test/a.test.ts", failing("Error: once\n"), [], LIMITS)
    const writes = classifyFile("test/a.test.ts", run(), ["packages/app/test/out.json"], LIMITS)
    const settled = settleFile(first, writes)
    expect(settled.verdict).toBe("fail")
    expect(settled.changed).toEqual(["packages/app/test/out.json"])
    expect(settled.reason).toBe(
      "fails run alone (exit 1) (a second run in a fresh container: writes; it changed the workspace: packages/app/test/out.json)",
    )
    const flaky = settleFile(
      classifyFile("test/a.test.ts", failing("Error: once\n"), ["packages/app/x"], LIMITS),
      classifyFile("test/a.test.ts", run(), [], LIMITS),
    )
    expect(flaky.verdict).toBe("flaky")
    expect(flaky.changed).toEqual(["packages/app/x"])
  })

  it("keeps the tail of the output, without terminal escapes, and its error lines without durations", () => {
    expect(outputTail("\u001b[31mred\u001b[0m\n")).toBe("red")
    expect(outputTail("x".repeat(5_000))).toBe(`…${"x".repeat(4_000)}`)
    expect(changedPaths({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" })).toEqual(["b", "c"])
    expect(changedPaths({ a: "1" }, {})).toEqual(["a"])
    expect(
      errorLines(
        " × a test 3ms\nError: ENOENT: no such file 12ms\nError: ENOENT: no such file 9ms\nTypeError: x\n",
      ),
    ).toEqual(["Error: ENOENT: no such file", "TypeError: x"])
  })
})

describe("the resources a measured suite proposes", () => {
  it("gives devkit's committed memory and verifier deadline from rung 2's measurement", () => {
    // Rung 2: build 1.4 s, suite 8.9 s, memory.peak 369 MiB; a session of 40 s. The committed
    // commandTimeoutMs (60000) is 6.7 times the suite, under this rule's eight times (80000).
    expect(
      proposeResources(
        [{ buildMs: 1_400, suiteMs: 8_900, sessionMs: 40_000, memoryPeakBytes: 369 * MiB }],
        2,
      ),
    ).toEqual({ memoryMb: 768, cpus: 2, commandTimeoutMs: 80_000, verifierDeadlineMs: 240_000 })
  })

  it("takes the worst of every sample, and never goes below its floors", () => {
    expect(
      proposeResources(
        [
          { buildMs: 3_700, suiteMs: 12_300, sessionMs: 60_000, memoryPeakBytes: 449 * MiB },
          { buildMs: 2_800, suiteMs: 15_300, sessionMs: 45_000, memoryPeakBytes: 487 * MiB },
        ],
        2,
      ),
    ).toEqual({ memoryMb: 1024, cpus: 2, commandTimeoutMs: 130_000, verifierDeadlineMs: 300_000 })
    expect(
      proposeResources([{ buildMs: 1, suiteMs: 1, sessionMs: 1, memoryPeakBytes: 1 }], 1),
    ).toEqual({
      memoryMb: 512,
      cpus: 1,
      commandTimeoutMs: 60_000,
      verifierDeadlineMs: 120_000,
    })
    expect(() => proposeResources([], 2)).toThrow(/no suite sample/)
  })

  it("never proposes below the target's own resources unless asked", () => {
    const measured = {
      memoryMb: 512,
      cpus: 2,
      commandTimeoutMs: 70_000,
      verifierDeadlineMs: 120_000,
    }
    const prior = { memoryMb: 768, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 240_000 }
    expect(settleResources(measured, prior, false)).toEqual({
      memoryMb: 768,
      cpus: 2,
      commandTimeoutMs: 70_000,
      verifierDeadlineMs: 240_000,
    })
    expect(settleResources(measured, prior, true)).toEqual(measured)
    expect(settleResources(measured, undefined, false)).toEqual(measured)
  })
})

describe("what a measurement writes", () => {
  const measurement: Measurement = {
    files: [
      {
        file: "test/a.test.ts",
        verdict: "pass",
        reason: "passes run alone",
        output: "",
        ms: 10,
        changed: [],
        omissions: [],
      },
      {
        file: "test/b.test.ts",
        verdict: "fail",
        reason: "fails run alone (exit 1)",
        output: "```\nError: boom 4ms",
        ms: 20,
        changed: [],
        omissions: [],
      },
      {
        file: "test/c.test.ts",
        verdict: "flaky",
        reason:
          "fails run alone (exit 1) on its first run, but passed a second run in a fresh container: listed, not excluded",
        output: "Error: once",
        ms: 30,
        changed: [],
        omissions: [],
      },
    ],
    excludes: ["test/b.test.ts"],
    test: ["pnpm", "exec", "vitest", "--run", "--exclude", "test/b.test.ts"],
    samples: [{ buildMs: 1_000, suiteMs: 2_000, sessionMs: 30_000, memoryPeakBytes: 300 * MiB }],
    measured: { memoryMb: 768, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 180_000 },
    prior: undefined,
    resources: { memoryMb: 768, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 180_000 },
    confirmation: { buildMs: 900, suiteMs: 2_100, sessionMs: 29_000, memoryPeakBytes: 310 * MiB },
  }

  it("a report that names every file, fences each output, and sets before, measured and proposed side by side", () => {
    const report = renderReport({
      target: { id: "app", pin: "a".repeat(40) },
      image: {
        localId: `sha256:${"b".repeat(64)}`,
        tag: "b4-factory-app:aaaaaaaaaaaa-cccccccccccc",
      },
      measurement,
      limits: LIMITS,
      notes: ["measured at another pin"],
    })
    expect(report).toContain(`# target:measure app at ${"a".repeat(40)}`)
    expect(report).toContain("> measured at another pin")
    expect(report).toContain("## Files: 3, 1 pass, 1 proposed for exclusion, 1 flaky")
    expect(report).toContain(
      "### `test/b.test.ts`: fail\n\nfails run alone (exit 1)\n\n````\n```\nError: boom 4ms\n````\n",
    )
    expect(report).toContain("| 1 | 1000 | 2000 | 30000 | 300 |")
    expect(report).toContain("| at the proposed resources | 900 | 2100 | 29000 | 310 |")
    expect(report).toContain("| memoryMb | (placeholder) | 768 | 768 |")
  })

  it("a committed record with each exclude's class and error lines, and no timing", () => {
    expect(renderMeasurementRecord("app", measurement.files)).toBe(
      [
        "# Measured excludes: app",
        "",
        "Written by `target:measure --write` and reviewed with `target.json`. Each file below is excluded from the target's suite, and so from every verification of a task on this target. The measurement's `report.md` holds the full output.",
        "",
        "- `test/b.test.ts`: fail. fails run alone (exit 1)",
        "  > Error: boom",
        "",
        "## Flaky: listed, not excluded",
        "",
        "- `test/c.test.ts`: flaky. fails run alone (exit 1) on its first run, but passed a second run in a fresh container: listed, not excluded",
        "  > Error: once",
        "",
      ].join("\n"),
    )
  })
})
