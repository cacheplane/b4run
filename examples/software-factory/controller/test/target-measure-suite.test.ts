import { describe, expect, it } from "vitest"
import type { TargetRecipe } from "../src/lib/targets/catalog.ts"
import { MeasureError } from "../src/lib/targets/measure/classify.ts"
import { type MeasureSuiteOptions, measureSuite } from "../src/lib/targets/measure/measure.ts"
import { relativeTo, reportFiles, withoutProject } from "../src/lib/targets/measure/session.ts"
import { type FakeScript, fakeSessions, vitestReport } from "./fake-measure-session.ts"

const BASE = ["pnpm", "exec", "vitest", "--run", "--no-cache", "--config", "vitest.config.ts"]
const FILE_LIMITS = { memoryMb: 4096, cpus: 2, commandTimeoutMs: 180_000 }
const recipe = (test: readonly string[] = BASE): Pick<TargetRecipe, "id" | "commands"> => ({
  id: "app",
  commands: {
    cwd: "packages/app",
    build: ["pnpm", "exec", "tsc", "-b", "tsconfig.json"],
    test: [...test],
    nodeTestExecArgv: [],
  },
})
/** A clock that advances 30 s per reading: every sampled session lasts 30 s. */
const clock = () => {
  let t = 0
  return () => (t += 30_000)
}
const measure = (
  script: FakeScript,
  test?: readonly string[],
  extra: Partial<MeasureSuiteOptions> = {},
) => {
  const fake = fakeSessions(script)
  return {
    fake,
    result: measureSuite({
      recipe: recipe(test),
      open: fake.open,
      fileTimeoutMs: 180_000,
      memoryMb: 4096,
      cpus: 2,
      runs: 1,
      allowDecrease: false,
      now: clock(),
      ...extra,
    }),
  }
}

describe("measureSuite", () => {
  it("runs each file alone, re-runs each non-pass, proposes an exclude per fail, hang or write, then samples and confirms the suite", async () => {
    const { fake, result } = measure({
      files: {
        "test/a.test.ts": {},
        "test/b.test.ts": { timedOut: true },
        "test/c.test.ts": { exitCode: 1 },
        "test/d.test.ts": { writes: ["packages/app/test/out.json"] },
      },
    })
    const m = await result
    expect(m.files.map((f) => [f.file, f.verdict])).toEqual([
      ["test/a.test.ts", "pass"],
      ["test/b.test.ts", "hang"],
      ["test/c.test.ts", "fail"],
      ["test/d.test.ts", "writes"],
    ])
    expect(m.excludes).toEqual(["test/b.test.ts", "test/c.test.ts", "test/d.test.ts"])
    expect(m.test).toEqual([
      ...BASE,
      "--exclude",
      "test/b.test.ts",
      "--exclude",
      "test/c.test.ts",
      "--exclude",
      "test/d.test.ts",
    ])
    // The listing, two file sessions (fresh after the hang; d's write ends the second), three
    // re-runs, one suite sample, one confirmation at the proposed resources.
    expect(fake.opened).toEqual([
      FILE_LIMITS,
      FILE_LIMITS,
      FILE_LIMITS,
      FILE_LIMITS,
      FILE_LIMITS,
      FILE_LIMITS,
      FILE_LIMITS,
      { memoryMb: 1024, cpus: 2, commandTimeoutMs: 80_000 },
    ])
    expect(fake.commands[0]).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "list",
      "--filesOnly",
      "--run",
      "--no-cache",
      "--config",
      "vitest.config.ts",
    ])
    expect(fake.commands.at(-1)).toEqual(m.test)
    expect(m.samples).toEqual([
      { buildMs: 1_000, suiteMs: 9_000, sessionMs: 30_000, memoryPeakBytes: 400 * 1024 * 1024 },
    ])
    expect(m.measured).toEqual({
      memoryMb: 1024,
      cpus: 2,
      commandTimeoutMs: 80_000,
      verifierDeadlineMs: 240_000,
    })
    expect(m.resources).toEqual(m.measured)
    expect(m.confirmation.sessionMs).toBe(30_000)
  })

  it("gives the next file a fresh container after a file that writes, and reports a failing file's writes", async () => {
    const { fake, result } = measure({
      files: {
        "test/a.test.ts": { exitCode: 1, writes: ["packages/app/tmp.txt"] },
        "test/b.test.ts": {},
        "test/c.test.ts": {},
      },
    })
    const m = await result
    const sessionOf = (file: string) =>
      fake.sessionOf.find((run) => run.argv.at(-1) === file)?.session
    // Session 1 is the listing.
    expect(sessionOf("test/a.test.ts")).toBe(2)
    expect(sessionOf("test/b.test.ts")).toBe(3)
    expect(sessionOf("test/c.test.ts")).toBe(3)
    const a = m.files[0]
    expect(a?.verdict).toBe("fail")
    expect(a?.changed).toEqual(["packages/app/tmp.txt"])
    expect(a?.reason).toContain('it also changed the workspace: "packages/app/tmp.txt"')
  })

  it("lists a file that fails once and then passes as flaky, and does not exclude it", async () => {
    const { result } = measure({
      files: { "test/a.test.ts": { flakyOnce: true }, "test/b.test.ts": {} },
    })
    const m = await result
    expect(m.files.map((f) => f.verdict)).toEqual(["flaky", "pass"])
    expect(m.excludes).toEqual([])
    expect(m.test).toEqual(BASE)
  })

  it("never proposes below the target's own resources unless asked, and confirms at what it proposes", async () => {
    const prior = {
      memoryMb: 2048,
      cpus: 2,
      commandTimeoutMs: 120_000,
      verifierDeadlineMs: 3_600_000,
    }
    const kept = measure({ files: { "test/a.test.ts": {} } }, BASE, { prior })
    expect((await kept.result).resources).toEqual(prior)
    expect(kept.fake.opened.at(-1)).toEqual({ memoryMb: 2048, cpus: 2, commandTimeoutMs: 120_000 })
    const shrunk = measure({ files: { "test/a.test.ts": {} } }, BASE, {
      prior,
      allowDecrease: true,
    })
    expect((await shrunk.result).resources).toEqual({
      memoryMb: 1024,
      cpus: 2,
      commandTimeoutMs: 80_000,
      verifierDeadlineMs: 240_000,
    })
  })

  it("refuses a proposal that does not hold when tried, keeping the files for a partial report", async () => {
    const { result } = measure({
      files: { "test/a.test.ts": {}, "test/b.test.ts": { exitCode: 1 } },
      suite: { minMemoryMb: 2000 },
    })
    const error = await result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MeasureError)
    expect((error as MeasureError).message).toMatch(/the proposed resources did not hold/)
    expect((error as MeasureError).files?.map((f) => f.verdict)).toEqual(["pass", "fail"])
  })

  it("keeps the files measured before a stop in the per-file pass, for a partial report", async () => {
    const error = await measure({
      files: { "test/a.test.ts": {}, "test/b.test.ts": { reports: ["test/x/test/b.test.ts"] } },
    }).result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MeasureError)
    expect((error as MeasureError).message).toMatch(/must select exactly this file/)
    expect((error as MeasureError).files?.map((f) => [f.file, f.verdict])).toEqual([
      ["test/a.test.ts", "pass"],
    ])
  })

  it("refuses a listed file whose name holds a control character", async () => {
    await expect(
      measure({ files: { "test/a.test.ts": {} }, listed: ["test/a\n## x.test.ts"] }).result,
    ).rejects.toThrow(/control character/)
  })

  it("keeps a scope, and samples the suite as many times as asked, each in a fresh container", async () => {
    const scope = ["test/a.test.ts", "test/b.test.ts"]
    const { fake, result } = measure(
      { files: { "test/a.test.ts": {}, "test/b.test.ts": { exitCode: 1 } } },
      [...BASE, ...scope],
      { runs: 3 },
    )
    const m = await result
    expect(fake.commands[0]?.slice(-2)).toEqual(scope)
    expect(m.test).toEqual([...BASE, ...scope, "--exclude", "test/b.test.ts"])
    expect(m.samples).toHaveLength(3)
    // The listing, one file session, b's re-run, three samples, one confirmation.
    expect(fake.opened).toHaveLength(7)
  })

  it("stops, proposing nothing, when the harness or the target is at fault", async () => {
    await expect(
      measure({ files: { "test/a.test.ts": { reports: ["test/x/test/a.test.ts"] } } }).result,
    ).rejects.toThrow(/must select exactly this file/)
    await expect(
      measure({ files: { "test/a.test.ts": {} }, build: { ok: false, output: "TS2307" } }).result,
    ).rejects.toThrow(/target's build fails in its own image/)
    await expect(
      measure({ files: { "test/a.test.ts": {} }, suite: { exitCode: 1 } }).result,
    ).rejects.toThrow(/The suite with the proposed excludes failed \(exit 1\) on run 1/)
    await expect(
      measure({ files: { "test/a.test.ts": {} }, suite: { writes: ["packages/app/x"] } }).result,
    ).rejects.toThrow(/changed the workspace \(packages\/app\/x\)/)
    await expect(measure({ files: { "test/a.test.ts": { exitCode: 1 } } }).result).rejects.toThrow(
      /no test file passes run alone/,
    )
    await expect(measure({ files: {} }).result).rejects.toThrow(MeasureError)
    await expect(measure({ files: {} }).result).rejects.toThrow(
      /vitest lists no test file for app's command/,
    )
    await expect(
      measure({
        files: { "test/a.test.ts": {} },
        listed: ["/workspace/packages/app/test/a.test.ts"],
      }).result,
    ).rejects.toThrow(/a measured file is a path relative to the command directory/)
  })

  it("runs each listed file by its name without vitest's [project] prefix", async () => {
    const { fake, result } = measure({
      files: { "test/a.test.ts": {}, "test/b.test.ts": {} },
      listed: ["[app] test/b.test.ts", "[app] test/a.test.ts"],
    })
    const m = await result
    expect(m.files.map((f) => f.file)).toEqual(["test/a.test.ts", "test/b.test.ts"])
    expect(fake.sessionOf.slice(0, 2).map((run) => run.argv.at(-1))).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
    ])
  })

  it("lists the files in a session of its own, so the first file starts from the verifier's state", async () => {
    const { fake, result } = measure({ files: { "test/a.test.ts": {}, "test/b.test.ts": {} } })
    await result
    expect(fake.listedIn).toEqual([1])
    expect(fake.sessionOf[0]?.session).toBe(2)
  })

  it("gives the next file a fresh container after a file the kernel killed", async () => {
    const { fake, result } = measure({
      files: { "test/a.test.ts": { killed: true }, "test/b.test.ts": {} },
    })
    const m = await result
    expect(m.files.map((f) => [f.file, f.verdict])).toEqual([
      ["test/a.test.ts", "killed"],
      ["test/b.test.ts", "pass"],
    ])
    const sessionOf = (file: string) =>
      fake.sessionOf
        .filter((run) => run.argv.at(-1) === file && !run.argv.includes("--exclude"))
        .map((run) => run.session)
    // a in the first file session, b in a fresh one, a's re-run in a third.
    expect(sessionOf("test/a.test.ts")).toEqual([2, 4])
    expect(sessionOf("test/b.test.ts")).toEqual([3])
  })

  it("classifies a file after which the verifier's inspection refuses the workspace as writes, and gives the next file a fresh container", async () => {
    // packages/cli's check-command.test.ts chmods the built CLI 0755: every verification with
    // it in the suite would be refused, so it is a file to exclude, not a stop.
    const refusal = "Executable workspace file: packages/cli/dist/index.js"
    const { fake, result } = measure({
      files: {
        "test/a.test.ts": {},
        "test/b.test.ts": { refuses: refusal },
        "test/c.test.ts": {},
        "test/d.test.ts": { exitCode: 1, refuses: refusal },
      },
    })
    const m = await result
    expect(m.files.map((f) => [f.file, f.verdict])).toEqual([
      ["test/a.test.ts", "pass"],
      ["test/b.test.ts", "writes"],
      ["test/c.test.ts", "pass"],
      ["test/d.test.ts", "writes"],
    ])
    expect(m.excludes).toEqual(["test/b.test.ts", "test/d.test.ts"])
    const b = m.files[1]
    expect(b?.reason).toBe(
      `the verifier's workspace inspection refuses the workspace after it: "${refusal}"`,
    )
    expect(b?.output).toContain("test/b.test.ts output")
    // Two refusals keep the first verdict; the second run's is on the result.
    expect(b?.secondRun).toMatch(/second run in a fresh container: writes/)
    // A failing file that also leaves a refused workspace says both.
    expect(m.files[3]?.reason).toBe(
      `the verifier's workspace inspection refuses the workspace after it: "${refusal}"; fails run alone (exit 1)`,
    )
    const sessionOf = (file: string) =>
      fake.sessionOf
        .filter((run) => run.argv.at(-1) === file && !run.argv.includes("--exclude"))
        .map((run) => run.session)
    // Session 1 lists; a and b share one; c starts a fresh one after b's refusal; the re-runs
    // of b and d each get their own.
    expect(sessionOf("test/a.test.ts")).toEqual([2])
    expect(sessionOf("test/b.test.ts")).toEqual([2, 4])
    expect(sessionOf("test/c.test.ts")).toEqual([3])
    expect(sessionOf("test/d.test.ts")).toEqual([3, 5])
  })

  it("sanitises a refusal before it reaches a reason", async () => {
    const m = await measure({
      files: {
        "test/a.test.ts": {},
        "test/b.test.ts": { refuses: "Executable workspace file: x\u001b[2J<!--\ny\n" },
      },
    }).result
    expect(m.files[1]?.reason).toBe(
      'the verifier\'s workspace inspection refuses the workspace after it: "Executable workspace file: x&lt;!-- y"',
    )
  })

  it("stops, naming the target, when the inspection refuses the workspace before any test ran", async () => {
    const error = await measure({
      files: { "test/a.test.ts": {}, "test/b.test.ts": {} },
      build: { refuses: "Binary workspace file: packages/app/dist/x.node" },
    }).result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MeasureError)
    expect((error as MeasureError).message).toMatch(
      /the verifier's workspace inspection refuses app's workspace after its build, before any test ran: "Binary workspace file: packages\/app\/dist\/x.node"/,
    )
  })

  it("stops when the inspection refuses the workspace after the suite: no resources for a suite every verification refuses", async () => {
    const error = await measure({
      files: { "test/a.test.ts": {}, "test/b.test.ts": { exitCode: 1 } },
      suite: { refuses: "Workspace entries limit exceeded" },
    }).result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MeasureError)
    expect((error as MeasureError).message).toMatch(
      /The suite with the proposed excludes left a workspace the verifier's inspection refuses \("Workspace entries limit exceeded"\), so every verification would be refused, on run 1/,
    )
    expect((error as MeasureError).files?.map((f) => f.verdict)).toEqual(["pass", "fail"])
  })

  it("stops, keeping the files, on a snapshot that fails for any other reason", async () => {
    const error = await measure({
      files: { "test/a.test.ts": {}, "test/b.test.ts": { snapshotFails: "EIO: i/o error" } },
    }).result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MeasureError)
    expect((error as MeasureError).message).toMatch(
      /The workspace snapshot after test\/b.test.ts failed: EIO: i\/o error/,
    )
    expect((error as MeasureError).files?.map((f) => f.verdict)).toEqual(["pass"])
  })

  it("refuses a suite the verifier would not grade a pass: no report, no test, or every test skipped", async () => {
    const files = { "test/a.test.ts": {} }
    for (const [report, why] of [
      ["", /wrote no JSON report/],
      ["{not json", /JSON report is not a vitest report/],
      [JSON.stringify({ numTotalTests: 0, numFailedTests: 0, testResults: [] }), /no test passed/],
      [vitestReport("skipped"), /no test passed/],
    ] as const) {
      const error = await measure({ files, suite: { report } }).result.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MeasureError)
      expect((error as MeasureError).message).toMatch(/would not grade it a pass/)
      expect((error as MeasureError).message).toMatch(why)
      expect((error as MeasureError).files?.map((f) => f.verdict)).toEqual(["pass"])
    }
  })

  it("refuses a suite that times out, in the samples or only at the proposed resources", async () => {
    const files = { "test/a.test.ts": {} }
    await expect(measure({ files, suite: { minTimeoutMs: 1_000_000 } }).result).rejects.toThrow(
      /did not finish within 180000 ms on run 1/,
    )
    // The samples run at 180 s; the proposal is 80 s.
    await expect(measure({ files, suite: { minTimeoutMs: 100_000 } }).result).rejects.toThrow(
      /did not finish within 80000 ms at the proposed resources/,
    )
  })

  it("refuses a proposal whose session, tried, does not fit twice in the proposed deadline", async () => {
    // Readings: sample start and end (30 s apart), then the confirmation's (at `last` s).
    const slowConfirmation = (last: number) => {
      const steps = [30_000, 30_000, 30_000, last]
      let t = 0
      return () => (t += steps.shift() ?? 30_000)
    }
    const files = { "test/a.test.ts": {} }
    // Measured: 2 x (the 80 s command timeout + a 30 s session), up to a minute: 240 s. Two
    // 120 s sessions fit; two 130 s do not.
    expect(
      (await measure({ files }, BASE, { now: slowConfirmation(120_000) }).result).confirmation
        .sessionMs,
    ).toBe(120_000)
    await expect(
      measure({ files }, BASE, { now: slowConfirmation(130_000) }).result,
    ).rejects.toThrow(
      /took 130000 ms; two of them do not fit the proposed verifierDeadlineMs 240000/,
    )
  })

  it("names a build killed or timed out at the proposed resources as the limits, not the target", async () => {
    const error = await measure({
      files: { "test/a.test.ts": {} },
      build: { minMemoryMb: 2000 },
    }).result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MeasureError)
    expect((error as MeasureError).message).toMatch(
      /The target's build exceeded the proposed resources .*exit 137/,
    )
    expect((error as MeasureError).message).not.toMatch(/a defect of the target/)
  })

  it("refuses, keeping the files, an exclude that cannot be written literally; and says so when it is listed", async () => {
    const lines: string[] = []
    const error = await measure(
      { files: { "test/a.test.ts": {}, "test/[id].test.ts": { exitCode: 1 } } },
      BASE,
      { log: (line) => lines.push(line) },
    ).result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MeasureError)
    expect((error as MeasureError).message).toMatch(
      /"test\/\[id\]\.test\.ts" \(fail\) cannot be written as a literal --exclude/,
    )
    expect((error as MeasureError).files?.map((f) => [f.file, f.verdict])).toEqual([
      ["test/[id].test.ts", "fail"],
      ["test/a.test.ts", "pass"],
    ])
    expect(lines).toContainEqual(
      expect.stringMatching(/note: .*"test\/\[id\]\.test\.ts".* could not be excluded/),
    )
  })
})

describe("reading what vitest printed", () => {
  it("strips the [project] prefix of a listed file, and nothing else", () => {
    expect(withoutProject("[software-factory-controller] test/a.test.ts")).toBe("test/a.test.ts")
    expect(withoutProject("test/a.test.ts")).toBe("test/a.test.ts")
    expect(withoutProject("test/[id]/a.test.ts")).toBe("test/[id]/a.test.ts")
  })

  it("makes vitest's absolute paths relative to the command directory, refusing any outside it", () => {
    expect(relativeTo("/workspace/packages/app", "/workspace/packages/app/test/a.test.ts")).toBe(
      "test/a.test.ts",
    )
    expect(relativeTo("/workspace/packages/app/", "/workspace/packages/app/test/a.test.ts")).toBe(
      "test/a.test.ts",
    )
    expect(() =>
      relativeTo("/workspace/packages/app", "/workspace/packages/app2/test/a.test.ts"),
    ).toThrow(MeasureError)
    expect(() => relativeTo("/workspace/packages/app", "/workspace/packages/app/")).toThrow(
      MeasureError,
    )
  })

  it("takes a file's pass from vitest's own status, exactly, and counts its tests", () => {
    const at = (file: string) => `/workspace/packages/app/${file}`
    expect(
      reportFiles(
        {
          testResults: [
            {
              name: at("test/ok.test.ts"),
              status: "passed",
              assertionResults: [{ status: "passed" }, { status: "skipped" }],
            },
            {
              name: at("test/skipped.test.ts"),
              status: "passed",
              assertionResults: [{ status: "skipped" }, { status: "todo" }],
            },
            { name: at("test/throws.test.ts"), status: "failed", assertionResults: [] },
            {
              name: at("test/bad.test.ts"),
              status: "failed",
              assertionResults: [{ status: "passed" }, { status: "failed" }],
            },
          ],
        },
        "/workspace/packages/app",
      ),
    ).toEqual([
      { file: "test/ok.test.ts", passed: true, tests: { passed: 1, failed: 0, skipped: 1 } },
      { file: "test/skipped.test.ts", passed: true, tests: { passed: 0, failed: 0, skipped: 2 } },
      { file: "test/throws.test.ts", passed: false, tests: { passed: 0, failed: 0, skipped: 0 } },
      { file: "test/bad.test.ts", passed: false, tests: { passed: 1, failed: 1, skipped: 0 } },
    ])
    expect(reportFiles({}, "/workspace/packages/app")).toEqual([])
  })
})
