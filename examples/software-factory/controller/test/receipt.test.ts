import { describe, expect, it } from "vitest"
import type { SuiteEvent } from "../src/lib/verification/checks-runner.ts"
import type { SuiteSession } from "../src/lib/verification/grade-suite.ts"
import {
  assembleReceipt,
  deadlinePlan,
  independentOnlyChecks,
  suiteChecks,
} from "../src/lib/verification/receipt.ts"

/**
 * Layer 1 over the verdict decision, which used to be inlined in the verifier and therefore
 * reachable only through Docker. Three of these five branches cost a container each in the
 * sandbox lane, and one of them — the build that succeeds in the visible session and fails in
 * the independent one — would need two containers that disagree, which no test can arrange.
 * As a pure function over the two sessions' outcomes it is all cheap.
 */
const ok = { ok: true, output: "built\n" }
const broken = { ok: false, output: "error TS2322: no\n" }
const suite = (
  verdict: "pass" | "fail" | "inconclusive",
  output: string,
  events: readonly SuiteEvent[] = [],
): SuiteSession["result"] => ({ verdict, output, events })
/** A named assertion failing by assertion: what an oracle's failure must be. */
const assertionFailed = (name = "A1"): SuiteEvent => ({
  type: "test:fail",
  name,
  failure: "ERR_ASSERTION",
})

const session = (over: Partial<SuiteSession> = {}): SuiteSession => ({
  build: ok,
  tampered: false,
  result: suite("pass", "12 passed\n"),
  ...over,
})

const acceptanceIds = { visible: ["V1", "V2"], independent: ["A1"] } as const
const plan = (visible: SuiteSession, independent: SuiteSession | null) =>
  assembleReceipt({ visible, independent, acceptanceIds })
const summary = (p: { checks: readonly { id: string; verdict: string }[] }) =>
  p.checks.map((c) => `${c.id}:${c.verdict}`)

describe("assembleReceipt", () => {
  it("grades a build failure in the visible session as fail, with the compiler output", () => {
    // A build failure is a fact about the candidate, not about the harness.
    const decided = plan(session({ build: broken, result: null }), null)
    expect(decided.verdict).toBe("fail")
    expect(summary(decided)).toEqual(["build:fail"])
    expect(decided.checks[0]?.evidence).toContain("error TS2322")
    // A build check grades no acceptance criterion: it never reached one.
    expect(decided.checks[0]?.acceptanceIds).toEqual([])
  })

  it("names the visible session when it tampered, and says so in the evidence", () => {
    const decided = plan(session({ tampered: true, result: suite("pass", "12 passed\n") }), null)
    expect(decided.verdict).toBe("fail")
    expect(summary(decided)).toEqual(["visible:fail"])
    // A `visible:fail` is also what simply failing the suite produces; only the evidence says
    // the run stopped because the workspace moved.
    expect(decided.checks[0]?.evidence).toContain("a suite mutated the workspace during visible")
    expect(decided.checks[0]?.evidence).toContain("12 passed")
  })

  it("names the independent session when it tampered", () => {
    const decided = plan(
      session(),
      session({ tampered: true, result: suite("pass", "1 passed\n") }),
    )
    expect(decided.verdict).toBe("fail")
    expect(summary(decided)).toEqual(["independent:fail"])
    expect(decided.checks[0]?.evidence).toContain(
      "a suite mutated the workspace during independent",
    )
  })

  it("calls a build that succeeded once and failed once inconclusive, never fail", () => {
    // Two containers disagreeing about the same bytes is a fact about the harness. Grading it
    // as a failure would let a flaky compiler reject a correct repair.
    const decided = plan(session(), session({ build: broken, result: null }))
    expect(decided.verdict).toBe("inconclusive")
    expect(summary(decided)).toEqual(["build:inconclusive"])
    expect(decided.checks[0]?.evidence).toContain(
      "the build succeeded in the visible session and failed in the independent one",
    )
    expect(decided.checks[0]?.evidence).toContain("error TS2322")
  })

  it("reports both suites with their acceptance ids when both ran", () => {
    const decided = plan(session(), session({ result: suite("pass", "1 passed\n") }))
    expect(decided.verdict).toBe("pass")
    expect(summary(decided)).toEqual(["visible:pass", "independent:pass"])
    expect(decided.checks.map((c) => c.acceptanceIds)).toEqual([["V1", "V2"], ["A1"]])
    expect(decided.checks.map((c) => c.evidence)).toEqual(["12 passed\n", "1 passed\n"])
  })

  it("takes the worst verdict across the two suites, in both directions", () => {
    // The invariant the whole factory rests on: passing the visible suite cannot carry a
    // failing oracle.
    const visiblePassOracleFail = plan(session(), session({ result: suite("fail", "A1 failed\n") }))
    expect(visiblePassOracleFail.verdict).toBe("fail")
    expect(summary(visiblePassOracleFail)).toEqual(["visible:pass", "independent:fail"])

    // Inconclusive is worse than pass and better than fail, and it blocks either way.
    const oracleUnknown = plan(session(), session({ result: suite("inconclusive", "no report") }))
    expect(oracleUnknown.verdict).toBe("inconclusive")

    const bothWaysRoundsToFail = plan(
      session({ result: suite("inconclusive", "no report") }),
      session({ result: suite("fail", "A1 failed\n") }),
    )
    expect(bothWaysRoundsToFail.verdict).toBe("fail")
  })

  it("refuses to invent a verdict when the independent session is missing for no reason", () => {
    // `independent` is null exactly when session A decided the verdict. A clean session A with
    // no session B is a bug in the caller, and a receipt is the one thing never to guess.
    expect(() => plan(session(), null)).toThrow(/independent session did not run/)
  })

  it("refuses to invent a verdict when a session reported neither a result nor a reason", () => {
    expect(() => plan(session({ result: null }), session())).toThrow(/a suite did not run/)
  })

  it("agrees with suiteChecks about the shape freezeBundle accepts", () => {
    // Two producers of the same two-check shape: the verifier's own path goes through
    // assembleReceipt, and the fakes and the bundle tests go through suiteChecks. Pin them
    // together so the ids, their order and the acceptance ids cannot drift apart.
    const decided = plan(session(), session({ result: suite("pass", "1 passed\n") }))
    const frozen = suiteChecks({
      visible: {
        verdict: "pass",
        acceptanceIds: acceptanceIds.visible,
        outputDigest: "a".repeat(64),
      },
      independent: {
        verdict: "pass",
        acceptanceIds: acceptanceIds.independent,
        outputDigest: "b".repeat(64),
      },
    })
    expect(decided.checks.map((c) => c.id)).toEqual(frozen.map((c) => c.id))
    expect(decided.checks.map((c) => c.verdict)).toEqual(frozen.map((c) => c.verdict))
    expect(decided.checks.map((c) => [...c.acceptanceIds])).toEqual(
      frozen.map((c) => [...c.acceptanceIds]),
    )
    // And the evidence id each check's output will be stored under.
    expect(frozen.map((c) => c.evidence[0]?.id)).toEqual(["visible/output", "independent/output"])
  })
})

describe("assembleReceipt in independentOnly mode", () => {
  // Intake proves a drafted check is an oracle by running the independent suite ALONE on the
  // unpatched baseline. There is no visible session, so every branch that used to consult one
  // has a single-session shape of its own.
  const alone = (independent: SuiteSession | null, visible: SuiteSession | null = null) =>
    assembleReceipt({ visible, independent, acceptanceIds, mode: "independentOnly" })

  it("reports the one independent check, carrying its verdict and acceptance ids", () => {
    const decided = alone(session({ result: suite("fail", "A1 failed\n", [assertionFailed()]) }))
    expect(decided.verdict).toBe("fail")
    expect(summary(decided)).toEqual(["independent:fail"])
    expect(decided.checks.map((c) => c.acceptanceIds)).toEqual([["A1"]])
    expect(decided.checks[0]?.evidence).toBe("A1 failed\n")
  })

  it("grades a build failure as fail with a single build check over the compiler output", () => {
    // No earlier session to disagree with: the build failed on the bytes it was handed, which
    // is a fact about them and not about the harness.
    const decided = alone(session({ build: broken, result: null }))
    expect(decided.verdict).toBe("fail")
    expect(summary(decided)).toEqual(["build:fail"])
    expect(decided.checks[0]?.evidence).toBe(broken.output)
    expect(decided.checks[0]?.acceptanceIds).toEqual([])
  })

  it("reports a tamper under its own check id, never as a failing independent check", () => {
    // `independent: fail` is what the oracle proof reads as "the check fails on the defect".
    // A check that mutated the workspace must not be able to prove itself that way.
    const decided = alone(session({ tampered: true, result: suite("pass", "1 passed\n") }))
    expect(decided.verdict).toBe("fail")
    expect(summary(decided)).toEqual(["tamper:fail"])
    expect(decided.checks[0]?.acceptanceIds).toEqual([])
    expect(decided.checks[0]?.evidence).toContain(
      "a suite mutated the workspace during independent",
    )
    expect(decided.checks[0]?.evidence).toContain("1 passed")
  })

  it("refuses to invent a verdict when the suite reported neither a result nor a reason", () => {
    expect(() => alone(session({ result: null }))).toThrow(/a suite did not run/)
  })

  it("refuses when the independent session did not run at all", () => {
    expect(() => alone(null)).toThrow(/independent session did not run/)
  })

  it("refuses a visible session, which the mode says must not have run", () => {
    expect(() => alone(session(), session())).toThrow(/visible/)
  })

  it("leaves full mode's refusal of a missing independent session in place", () => {
    expect(() => assembleReceipt({ visible: session(), independent: null, acceptanceIds })).toThrow(
      /independent session did not run/,
    )
  })

  it("refuses full mode without a visible session", () => {
    expect(() =>
      assembleReceipt({ visible: null, independent: session(), acceptanceIds, mode: "full" }),
    ).toThrow(/visible/)
  })

  it("grades a check that failed to load as inconclusive: it proves nothing", () => {
    // What node:test reports for a missing module, a syntax error or a top-level throw: one
    // failure named after the file, with no cause, and no named test at all.
    const decided = alone(
      session({
        result: suite("fail", "Cannot find module\n", [
          { type: "test:fail", name: "checks/runs-wait.test.ts" },
        ]),
      }),
    )
    expect(decided.verdict).toBe("inconclusive")
    expect(summary(decided)).toEqual(["independent:inconclusive"])
    expect(decided.checks[0]?.evidence).toMatch(
      /^inconclusive: the check file failed to load \("checks\/runs-wait\.test\.ts"\): no error message was reported; no named test ran, so it proves nothing\n/,
    )
    expect(decided.checks[0]?.evidence).toContain("Cannot find module")
  })

  it("grades a failure only an unnamed test reports as inconclusive, even beside a named one", () => {
    const extra = { type: "test:fail", name: "setup", failure: "ERR_ASSERTION" }
    expect(alone(session({ result: suite("fail", "", [extra]) })).verdict).toBe("inconclusive")
    const both = alone(session({ result: suite("fail", "", [assertionFailed(), extra]) }))
    expect(both.verdict).toBe("inconclusive")
    expect(both.checks[0]?.evidence).toContain(
      '"setup" failed with ERR_ASSERTION, but it is not a named assertion',
    )
  })

  it("never reads a todo or skipped test's failure as the proving assertion", () => {
    // node:test runs a `test.todo` and reports its failure without failing the run: a check
    // whose only failing assertion is a todo has proved nothing about the defect.
    for (const flag of [{ todo: true as const }, { skip: true as const }]) {
      const marked = { ...assertionFailed(), ...flag }
      const decided = alone(session({ result: suite("fail", "", [marked]) }))
      expect(decided.verdict).toBe("inconclusive")
      expect(decided.checks[0]?.evidence).toContain(
        `"A1" failed with ERR_ASSERTION, but it is marked ${"todo" in flag ? "todo" : "skip"}`,
      )
      // Beside a real failing assertion, the real one still proves.
      expect(
        alone(session({ result: suite("fail", "", [marked, assertionFailed()]) })).verdict,
      ).toBe("fail")
    }
  })

  it("grades a named test that failed by a throw, not an assertion, as inconclusive", () => {
    const threw = { type: "test:fail", name: "A1", failure: "TypeError" }
    const decided = alone(session({ result: suite("fail", "", [threw]) }))
    expect(decided.verdict).toBe("inconclusive")
    expect(decided.checks[0]?.evidence).toMatch(
      /^inconclusive: "A1" failed with TypeError, not an assertion failure: the check must reach the behaviour and fail on an assert\n/,
    )
    // With no events at all a failure is still not a named assertion failing.
    expect(alone(session({ result: suite("fail", "") })).verdict).toBe("inconclusive")
  })

  it("quotes each failure's code and message, one line, as attempt 4's refusal should have", () => {
    // Attempt 4: the check's fixture route exported a default function, so the runtime threw
    // B4_E1007 before the check reached the behaviour. The refusal must say so, not read as
    // if A1 failed by assertion.
    const name =
      "A1: POST /threads/:id/runs/wait returns HTTP 200 and a JSON body (not a 500) when the route's entry returns undefined."
    const decided = assembleReceipt({
      visible: null,
      mode: "independentOnly",
      acceptanceIds: { visible: [], independent: [name, "A2: y"] },
      independent: session({
        result: suite("fail", "stderr\n", [
          {
            type: "test:fail",
            name,
            failure: "B4_E1007",
            message:
              "Route entry /tmp/b4run-test-x/src/app/noop/index.ts has no recognisable export (found: default).",
          },
          { type: "test:fail", name: "A2: y", failure: "ERR_ASSERTION", todo: true },
        ]),
      }),
    })
    expect(decided.verdict).toBe("inconclusive")
    const [first, ...rest] = (decided.checks[0]?.evidence ?? "").split("\n")
    expect(first).toBe(
      'inconclusive: A1 failed with B4_E1007 ("Route entry /tmp/b4run-test-x/src/app/noop/index.ts has no recognisable export (found: default)."), not an assertion failure: the check must reach the behaviour and fail on an assert; A2 failed with ERR_ASSERTION, but it is marked todo: a todo test proves nothing',
    )
    expect(rest.join("\n")).toBe("stderr\n")
  })

  it("says a check file failed to load, with the error line the runner saw", () => {
    const decided = alone(
      session({
        result: suite("fail", "", [
          {
            type: "test:fail",
            name: "checks/runs-wait.test.ts",
            message: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/workspace/dist/x.js'",
          },
        ]),
      }),
    )
    expect(decided.checks[0]?.evidence.split("\n")[0]).toBe(
      `inconclusive: the check file failed to load ("checks/runs-wait.test.ts"): Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/workspace/dist/x.js'; no named test ran, so it proves nothing`,
    )
  })

  it("proves a named assertion failing by assertion, beside named tests that threw", () => {
    const decided = alone(
      session({
        result: suite("fail", "", [
          assertionFailed(),
          { type: "test:fail", name: "A1", failure: "TypeError" },
        ]),
      }),
    )
    expect(summary(decided)).toEqual(["independent:fail"])
    expect(decided.checks[0]?.evidence).toBe("")
  })

  it("leaves full-mode grading alone: a failure there needs no named assertion", () => {
    const decided = plan(session(), session({ result: suite("fail", "boom\n") }))
    expect(decided.verdict).toBe("fail")
    expect(summary(decided)).toEqual(["visible:pass", "independent:fail"])
  })

  it("agrees with independentOnlyChecks about the shape freezeBundle accepts", () => {
    const decided = alone(session({ result: suite("fail", "A1 failed\n", [assertionFailed()]) }))
    const frozen = independentOnlyChecks({
      verdict: "fail",
      acceptanceIds: acceptanceIds.independent,
      outputDigest: "b".repeat(64),
    })
    expect(decided.checks.map((c) => c.id)).toEqual(frozen.map((c) => c.id))
    expect(decided.checks.map((c) => c.verdict)).toEqual(frozen.map((c) => c.verdict))
    expect(decided.checks.map((c) => [...c.acceptanceIds])).toEqual(
      frozen.map((c) => [...c.acceptanceIds]),
    )
    expect(frozen.map((c) => c.evidence[0]?.id)).toEqual(["independent/output"])
  })
})

describe("deadlinePlan", () => {
  it("is inconclusive and names the budget it exceeded", () => {
    const decided = deadlinePlan(240_000)
    expect(decided.verdict).toBe("inconclusive")
    expect(summary(decided)).toEqual(["deadline:inconclusive"])
    expect(decided.checks[0]?.evidence).toContain("240000ms")
  })
})
