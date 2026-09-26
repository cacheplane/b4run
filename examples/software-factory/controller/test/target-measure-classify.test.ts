import { describe, expect, it } from "vitest"
import { PLACEHOLDER_RESOURCES } from "../src/lib/targets/catalog.ts"
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
  renderFiles,
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
  report: "",
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
    expect(classifyFile("test/a.test.ts", run(), [])).toEqual({
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
    expect(classifyFile("test/a.test.ts", failing("AssertionError: nope\n"), [])).toMatchObject({
      verdict: "fail",
      reason: "fails run alone (exit 1)",
      output: "AssertionError: nope",
      tests: { passed: 0, failed: 2, skipped: 1 },
    })
    expect(
      classifyFile("test/a.test.ts", run({ exitCode: 124, timedOut: true, files: null }), []),
    ).toMatchObject({
      verdict: "hang",
      reason: "did not finish within the per-file timeout (--file-timeout-ms) run alone",
    })
    expect(classifyFile("test/a.test.ts", run({ exitCode: 137, files: null }), [])).toMatchObject({
      verdict: "killed",
      reason:
        "was killed (exit 137, with no report: the session's memory limit, --memory-mb, or a SIGKILL)",
    })
    const writes = classifyFile("test/a.test.ts", run(), ["packages/app/test/out.json"])
    expect(writes.verdict).toBe("writes")
    expect(writes.reason).toBe(
      `passes, but changes the workspace, which the verifier refuses as tampering: "packages/app/test/out.json"`,
    )
  })

  it("reports what a failing file changed too, and names a capture omission", () => {
    const output =
      "Error: ENOENT: no such file or directory, open '/workspace/packages/devkit/templates/app-basic/AGENTS.md'\n"
    const result = classifyFile(
      "test/a.test.ts",
      failing(output),
      ["packages/app/test/out.json"],
      (path) => path === "packages/devkit/templates/app-basic/AGENTS.md",
    )
    expect(result.verdict).toBe("fail")
    expect(result.changed).toEqual(["packages/app/test/out.json"])
    expect(result.omissions).toEqual(["packages/devkit/templates/app-basic/AGENTS.md"])
    expect(result.reason).toBe(
      `fails run alone (exit 1); it also changed the workspace: "packages/app/test/out.json"; capture omission: "packages/devkit/templates/app-basic/AGENTS.md" exist(s) at the pin but not in the capture`,
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
      ),
    ).toThrow(MeasureError)
    expect(() => classifyFile("test/a.test.ts", run({ files: [], exitCode: 1 }), [])).toThrow(
      /must select exactly this file/,
    )
    expect(() => classifyFile("test/a.test.ts", run({ files: null, exitCode: 2 }), [])).toThrow(
      /wrote no report/,
    )
  })

  it("settles two runs: a disagreement is flaky, never excluded", () => {
    const first = classifyFile("test/a.test.ts", failing("Error: once\n"), [])
    const pass = classifyFile("test/a.test.ts", run(), [])
    expect(settleFile(first, pass)).toMatchObject({
      verdict: "flaky",
      reason:
        "fails run alone (exit 1) on its first run, but passed a second run in a fresh container: listed, not excluded",
    })
    expect(settleFile(first, first)).toMatchObject({
      verdict: "fail",
      reason: "fails run alone (exit 1)",
      secondRun: "a second run in a fresh container: fail",
    })
    expect(settleFile(pass, first)).toBe(pass)
    expect(EXCLUDED.has("flaky")).toBe(false)
    expect([...EXCLUDED].sort()).toEqual(["fail", "hang", "killed", "writes"])
  })

  it("keeps what either run changed or could not find, whichever verdict it settles on", () => {
    const first = classifyFile("test/a.test.ts", failing("Error: once\n"), [])
    const writes = classifyFile("test/a.test.ts", run(), ["packages/app/test/out.json"])
    const settled = settleFile(first, writes)
    expect(settled.verdict).toBe("fail")
    expect(settled.changed).toEqual(["packages/app/test/out.json"])
    expect(settled.reason).toBe("fails run alone (exit 1)")
    expect(settled.secondRun).toBe(
      'a second run in a fresh container: writes; it changed the workspace: "packages/app/test/out.json"',
    )
    const flaky = settleFile(
      classifyFile("test/a.test.ts", failing("Error: once\n"), ["packages/app/x"]),
      classifyFile("test/a.test.ts", run(), []),
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
        secondRun: "a second run in a fresh container: fail",
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
      "### `test/b.test.ts`: fail\n\nfails run alone (exit 1)\n\na second run in a fresh container: fail\n\n````\n```\nError: boom 4ms\n````\n",
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
        "  > `Error: boom`",
        "",
        "## Flaky: listed, not excluded",
        "",
        "- `test/c.test.ts`: flaky. fails run alone (exit 1) on its first run, but passed a second run in a fresh container: listed, not excluded",
        "  > `Error: once`",
        "",
      ].join("\n"),
    )
  })
})

// Anything a terminal, git or GitHub's renderer would act on: C0 and C1 controls but \n and \t.
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

describe("guards a mutation would slip past", () => {
  it("is a harness error when the report names one file, but not this one", () => {
    expect(() =>
      classifyFile(
        "test/a.test.ts",
        run({ files: [{ file: "test/x/test/a.test.ts", passed: true, tests: COUNTS }] }),
        [],
      ),
    ).toThrow(MeasureError)
  })

  it("is a harness error, never an exclude, when vitest exits 0 but the file did not pass", () => {
    expect(() =>
      classifyFile(
        "test/a.test.ts",
        run({ files: [{ file: "test/a.test.ts", passed: false, tests: COUNTS }] }),
        [],
      ),
    ).toThrow(MeasureError)
    expect(() =>
      classifyFile(
        "test/a.test.ts",
        run({ files: [{ file: "test/a.test.ts", passed: false, tests: COUNTS }] }),
        [],
      ),
    ).toThrow(/exited 0/)
  })

  it("fails, not killed, when an exit 137 still wrote a report", () => {
    expect(
      classifyFile(
        "test/a.test.ts",
        run({
          exitCode: 137,
          files: [{ file: "test/a.test.ts", passed: false, tests: COUNTS }],
        }),
        [],
      ).verdict,
    ).toBe("fail")
  })

  it("never settles below the target's own cpus or per-command timeout", () => {
    const measured = {
      memoryMb: 1024,
      cpus: 2,
      commandTimeoutMs: 70_000,
      verifierDeadlineMs: 300_000,
    }
    const prior = { memoryMb: 512, cpus: 4, commandTimeoutMs: 90_000, verifierDeadlineMs: 120_000 }
    expect(settleResources(measured, prior, false)).toEqual({
      memoryMb: 1024,
      cpus: 4,
      commandTimeoutMs: 90_000,
      verifierDeadlineMs: 300_000,
    })
  })

  it("treats placeholder resources as no prior", () => {
    const measured = {
      memoryMb: 768,
      cpus: 2,
      commandTimeoutMs: 60_000,
      verifierDeadlineMs: 180_000,
    }
    expect(settleResources(measured, PLACEHOLDER_RESOURCES, false)).toEqual(measured)
  })

  it("refuses to propose from a sample that is not a measurement", () => {
    const good = { buildMs: 1_000, suiteMs: 2_000, sessionMs: 30_000, memoryPeakBytes: 300 * MiB }
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY])
      for (const field of ["buildMs", "suiteMs", "sessionMs", "memoryPeakBytes"] as const)
        expect(() => proposeResources([good, { ...good, [field]: bad }], 2)).toThrow(MeasureError)
    for (const cpus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => proposeResources([good], cpus)).toThrow(MeasureError)
  })
})

describe("what reaches report.md, measurement.md and the printed diff", () => {
  const hostile =
    "Error: a\u001b]8;;http://x\u0007link\u001b]8;;\u0007 \u001bM\u001b[2K fine\rHIDDEN <!-- \u0000\u0008\n" +
    "TypeError: b \u001b[>4;2m\u001b[?25l\u001b[1 q\u001b]0;title\u001b\\\u009b31mc\u0085\n"

  it("strips every escape sequence and control but newline and tab, and escapes <", () => {
    expect(outputTail(hostile)).toBe("Error: alink  fineHIDDEN &lt;!-- \nTypeError: b c")
    expect(errorLines(hostile)).toEqual(["Error: alink  fineHIDDEN &lt;!--", "TypeError: b c"])
    expect(outputTail("a\tb\r\nc")).toBe("a\tb\nc")
  })

  it("quotes workspace paths in a reason, so a path cannot inject a line", () => {
    const f = classifyFile("test/a.test.ts", failing(hostile), [
      "pkg/x\n## injected\n- `test/z.test.ts`: fine",
      "pkg/<!--y",
    ])
    expect(f.reason).toBe(
      'fails run alone (exit 1); it also changed the workspace: "pkg/x\\n## injected\\n- `test/z.test.ts`: fine", "pkg/<!--y"'.replace(
        "<",
        "\\u003c",
      ),
    )
    for (const text of [renderMeasurementRecord("app", [f]), renderFiles([f]).join("\n")]) {
      expect(text).not.toMatch(CONTROL)
      expect(text).not.toContain("<")
      expect(text.split("\n").some((line) => line.startsWith("## injected"))).toBe(false)
    }
  })

  it("quotes each error line in a code span, whatever backticks it holds", () => {
    const f = classifyFile("test/a.test.ts", failing("Error: `x` failed\nError: ends `x`\n"), [])
    expect(renderMeasurementRecord("app", [f])).toContain(
      "  > ``Error: `x` failed``\n  > `` Error: ends `x` ``\n",
    )
  })

  it("names a capture omission by its normalised path, never the workspace itself", () => {
    const asked: string[] = []
    const exists = (path: string) => {
      asked.push(path)
      return true
    }
    expect(
      captureOmissions("Error: ENOENT: no such file or directory, scandir '/workspace/'", exists),
    ).toEqual([])
    expect(
      captureOmissions("ENOENT: no such file or directory, open '/workspace/pkg/../x'", exists),
    ).toEqual(["x"])
    expect(captureOmissions("ENOENT: open '/workspace/../etc/passwd'", exists)).toEqual([])
    expect(captureOmissions("ENOENT: scandir '/workspace/pkg/dir/'", exists)).toEqual(["pkg/dir"])
    expect(asked).toEqual(["x", "pkg/dir"])
    expect(captureOmissions("ENOENT: open '/workspace/pkg/a'", () => false)).toEqual([])
  })

  it("writes the same record whatever the run's limits, order or second run", () => {
    const hang = classifyFile(
      "test/b.test.ts",
      run({ exitCode: 124, timedOut: true, files: null }),
      [],
    )
    const killed = classifyFile("test/a.test.ts", run({ exitCode: 137, files: null }), [])
    const settled = settleFile(
      killed,
      classifyFile(
        "test/a.test.ts",
        run({ exitCode: 1, files: [{ file: "test/a.test.ts", passed: false, tests: COUNTS }] }),
        ["packages/app/tmp-8f3a"],
      ),
    )
    const record = renderMeasurementRecord("app", [hang, settled])
    expect(record).toBe(renderMeasurementRecord("app", [settled, hang]))
    expect(record.indexOf("test/a.test.ts")).toBeLessThan(record.indexOf("test/b.test.ts"))
    expect(record).not.toMatch(/\d{4,}/)
    expect(record).not.toContain("second run")
    expect(record).not.toContain("tmp-8f3a")
    expect(renderFiles([settled]).join("\n")).toContain("tmp-8f3a")
  })

  it("does not claim every file passed when a flaky file is listed", () => {
    const failing = run({
      exitCode: 1,
      files: [{ file: "test/a.test.ts", passed: false, tests: COUNTS }],
    })
    const flaky = settleFile(
      classifyFile("test/a.test.ts", failing, []),
      classifyFile("test/a.test.ts", run(), []),
    )
    expect(flaky.verdict).toBe("flaky")
    const record = renderMeasurementRecord("app", [flaky])
    expect(record).not.toContain("every file passed run alone")
    expect(record).toContain(
      "No file is excluded: each file passed at least one of its runs alone; the flaky ones below also failed one.",
    )
    expect(renderMeasurementRecord("app", [classifyFile("test/a.test.ts", run(), [])])).toContain(
      "No file is excluded: every file passed run alone.",
    )
  })
})
