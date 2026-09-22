import { describe, expect, it } from "vitest"
import {
  gradeNodeTestEvents,
  gradeVitestReport,
  runBuild,
  runNodeTestSuite,
  shellJoin,
} from "../src/lib/verification/checks-runner.ts"

describe("shellJoin", () => {
  it("single-quotes every argument so a manifest cannot smuggle shell syntax", () => {
    expect(shellJoin(["pnpm", "exec", "vitest", "--run"])).toBe("'pnpm' 'exec' 'vitest' '--run'")
    expect(shellJoin(["echo", "a b; rm -rf /", "it's"])).toBe("'echo' 'a b; rm -rf /' 'it'\\''s'")
  })
})

const report = (results: { fullName: string; status: string }[], failed = 0) =>
  JSON.stringify({
    numFailedTests: failed,
    numTotalTests: results.length,
    testResults: [
      { name: "test/a.test.ts", status: failed ? "failed" : "passed", assertionResults: results },
    ],
  })

describe("gradeVitestReport", () => {
  it("passes when every named assertion passed exactly once and nothing failed", () => {
    const graded = gradeVitestReport(
      0,
      report([
        { fullName: "a passes", status: "passed" },
        { fullName: "b passes", status: "passed" },
      ]),
      ["a passes"],
    )
    expect(graded.verdict).toBe("pass")
    expect(graded.events).toEqual([
      { type: "test:pass", name: "a passes" },
      { type: "test:pass", name: "b passes" },
    ])
  })

  it("fails when a named assertion failed, or any test failed", () => {
    expect(
      gradeVitestReport(1, report([{ fullName: "a passes", status: "failed" }], 1), ["a passes"])
        .verdict,
    ).toBe("fail")
    expect(
      gradeVitestReport(
        1,
        report(
          [
            { fullName: "a passes", status: "passed" },
            { fullName: "c", status: "failed" },
          ],
          1,
        ),
        ["a passes"],
      ).verdict,
    ).toBe("fail")
  })

  it("is inconclusive when a named assertion is missing, skipped, duplicated, or the report is unreadable", () => {
    expect(
      gradeVitestReport(0, report([{ fullName: "b passes", status: "passed" }]), ["a passes"])
        .verdict,
    ).toBe("inconclusive")
    expect(
      gradeVitestReport(0, report([{ fullName: "a passes", status: "skipped" }]), ["a passes"])
        .verdict,
    ).toBe("inconclusive")
    expect(gradeVitestReport(0, "not json", ["a passes"]).verdict).toBe("inconclusive")
    expect(
      gradeVitestReport(
        0,
        report([
          { fullName: "a passes", status: "passed" },
          { fullName: "a passes", status: "passed" },
        ]),
        ["a passes"],
      ).verdict,
    ).toBe("inconclusive")
  })

  it("is inconclusive on a zero exit code with a failure count, which is a runner defect", () => {
    expect(
      gradeVitestReport(0, report([{ fullName: "a passes", status: "passed" }], 1), ["a passes"])
        .verdict,
    ).toBe("inconclusive")
  })

  it("is inconclusive on a nonzero exit with no failure recorded", () => {
    expect(
      gradeVitestReport(1, report([{ fullName: "a passes", status: "passed" }]), ["a passes"])
        .verdict,
    ).toBe("inconclusive")
  })

  it("is inconclusive when numFailedTests is absent on an otherwise-passing report", () => {
    const noFailedCount = JSON.stringify({
      numTotalTests: 1,
      testResults: [
        {
          assertionResults: [{ fullName: "a passes", status: "passed" }],
        },
      ],
    })
    expect(gradeVitestReport(0, noFailedCount, ["a passes"]).verdict).toBe("inconclusive")
  })

  it("is inconclusive, never a throw, when the parsed JSON is not a report shape", () => {
    expect(gradeVitestReport(0, "null", ["a passes"]).verdict).toBe("inconclusive")
    expect(gradeVitestReport(0, JSON.stringify({ testResults: 5 }), ["a passes"]).verdict).toBe(
      "inconclusive",
    )
    expect(
      gradeVitestReport(0, JSON.stringify({ testResults: [{ assertionResults: 7 }] }), ["a passes"])
        .verdict,
    ).toBe("inconclusive")
  })

  it("is inconclusive when numTotalTests is less than the number of expected assertions", () => {
    const shortTotal = report([{ fullName: "a passes", status: "passed" }])
    expect(gradeVitestReport(0, shortTotal, ["a passes", "b passes"]).verdict).toBe("inconclusive")
  })

  it("returns failureMessages for a failed assertion", () => {
    const withFailure = JSON.stringify({
      numFailedTests: 1,
      numTotalTests: 1,
      testResults: [
        {
          assertionResults: [
            {
              fullName: "a passes",
              status: "failed",
              failureMessages: ["expected 1 to be 2"],
            },
          ],
        },
      ],
    })
    expect(gradeVitestReport(1, withFailure, ["a passes"]).failureMessages).toEqual([
      "expected 1 to be 2",
    ])
  })
})

describe("gradeNodeTestEvents", () => {
  const ev = (type: string, name: string, skip = false, todo = false) => ({
    type,
    name,
    skip,
    todo,
  })
  it("passes only on exactly the named passing events", () => {
    expect(gradeNodeTestEvents(0, [ev("test:pass", "x")], ["x"]).verdict).toBe("pass")
    expect(
      gradeNodeTestEvents(0, [ev("test:pass", "x"), ev("test:pass", "y")], ["x"]).verdict,
    ).toBe("inconclusive")
    expect(gradeNodeTestEvents(1, [ev("test:fail", "x")], ["x"]).verdict).toBe("fail")
    expect(gradeNodeTestEvents(0, [ev("test:pass", "x", true)], ["x"]).verdict).toBe("inconclusive")
  })

  it("is inconclusive on a nonzero exit with every named event passing", () => {
    expect(gradeNodeTestEvents(1, [ev("test:pass", "x")], ["x"]).verdict).toBe("inconclusive")
  })

  it("is inconclusive on a todo event", () => {
    expect(gradeNodeTestEvents(0, [ev("test:pass", "x", false, true)], ["x"]).verdict).toBe(
      "inconclusive",
    )
  })

  it("is inconclusive when no assertions were expected", () => {
    expect(gradeNodeTestEvents(0, [ev("test:pass", "x")], []).verdict).toBe("inconclusive")
  })
})

describe("runBuild", () => {
  it("resolves ok with a no-op message and never touches the handle when the build argv is empty", async () => {
    const handle = {
      workspaceRoot: "/workspace",
      exec: {
        runCommand: () => {
          throw new Error("must not be called")
        },
      },
    } as unknown as Parameters<typeof runBuild>[0]
    const result = await runBuild(
      handle,
      { commands: { build: [] } } as never,
      AbortSignal.timeout(1000),
    )
    expect(result).toEqual({ ok: true, output: "(no build step)\n" })
  })
})

/** A handle that runs nothing and records the one command string it was handed. */
function recordingHandle(stdout: string) {
  const commands: string[] = []
  const handle = {
    workspaceRoot: "/workspace",
    exec: {
      runCommand: (request: { command: string }) => {
        commands.push(request.command)
        return Promise.resolve({ stdout, stderr: "", exitCode: 0 })
      },
    },
  } as unknown as Parameters<typeof runBuild>[0]
  return { handle, commands }
}

const devkit = {
  commands: {
    cwd: "packages/devkit",
    build: ["pnpm", "build"],
    test: ["pnpm", "test"],
    nodeTestExecArgv: ["--import", "tsx"],
  },
} as never

describe("the runner's working directory", () => {
  it("runs a node-test suite at the workspace root, never inside the target's cwd", async () => {
    // Suite paths are workspace-root-relative: the independent check is written to
    // `checks/<name>` at the root, so a `cd` into the target's cwd would not find it.
    const { handle, commands } = recordingHandle(JSON.stringify({ events: [], output: "" }))
    await runNodeTestSuite(
      handle,
      devkit,
      { runner: "node-test", file: "checks/independent.test.ts", assertions: ["a"] },
      AbortSignal.timeout(1000),
    )
    expect(commands).toHaveLength(1)
    expect(commands[0]).not.toContain("cd ")
    expect(commands[0]).toContain("/usr/local/bin/node <<'B4_SUITE_PROGRAM'")
    expect(commands[0]).toContain('"checks/independent.test.ts"')
  })

  it("runs the build inside the target's cwd", async () => {
    const { handle, commands } = recordingHandle("")
    await runBuild(handle, devkit, AbortSignal.timeout(1000))
    expect(commands).toEqual(["'cd' 'packages/devkit' && 'pnpm' 'build'"])
  })
})

describe("gradeVitestReport with no named assertions", () => {
  // A generated task's visible suite: the target's whole suite is the regression guard.
  it("passes when the suite ran, something ran, and nothing failed", () => {
    expect(
      gradeVitestReport(0, report([{ fullName: "a passes", status: "passed" }]), []).verdict,
    ).toBe("pass")
    expect(
      gradeVitestReport(
        0,
        report([
          { fullName: "a passes", status: "passed" },
          { fullName: "b passes", status: "passed" },
        ]),
        [],
      ).verdict,
    ).toBe("pass")
  })

  it("fails on a recorded failure with a nonzero exit", () => {
    expect(
      gradeVitestReport(1, report([{ fullName: "a passes", status: "failed" }], 1), []).verdict,
    ).toBe("fail")
  })

  it("is inconclusive on an invalid report, a zero-total report, or a nonzero exit with no failure", () => {
    expect(gradeVitestReport(0, "not json", []).verdict).toBe("inconclusive")
    expect(gradeVitestReport(0, "null", []).verdict).toBe("inconclusive")
    expect(gradeVitestReport(0, report([]), []).verdict).toBe("inconclusive")
    expect(
      gradeVitestReport(1, report([{ fullName: "a passes", status: "passed" }]), []).verdict,
    ).toBe("inconclusive")
    expect(
      gradeVitestReport(0, report([{ fullName: "a passes", status: "passed" }], 1), []).verdict,
    ).toBe("inconclusive")
    const noTotal = JSON.stringify({
      numFailedTests: 0,
      testResults: [{ assertionResults: [{ fullName: "a passes", status: "passed" }] }],
    })
    expect(gradeVitestReport(0, noTotal, []).verdict).toBe("inconclusive")
  })
})
