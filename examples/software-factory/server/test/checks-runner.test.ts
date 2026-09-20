import { describe, expect, it } from "vitest"
import {
  gradeNodeTestEvents,
  gradeVitestReport,
  shellJoin,
} from "../src/verification/checks-runner.ts"

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
    expect(
      gradeVitestReport(0, report([{ fullName: "a passes", status: "passed" }]), []).verdict,
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
})

describe("gradeNodeTestEvents", () => {
  const ev = (type: string, name: string, skip = false) => ({ type, name, skip, todo: false })
  it("passes only on exactly the named passing events", () => {
    expect(gradeNodeTestEvents(0, [ev("test:pass", "x")], ["x"]).verdict).toBe("pass")
    expect(
      gradeNodeTestEvents(0, [ev("test:pass", "x"), ev("test:pass", "y")], ["x"]).verdict,
    ).toBe("inconclusive")
    expect(gradeNodeTestEvents(1, [ev("test:fail", "x")], ["x"]).verdict).toBe("fail")
    expect(gradeNodeTestEvents(0, [ev("test:pass", "x", true)], ["x"]).verdict).toBe("inconclusive")
  })
})
