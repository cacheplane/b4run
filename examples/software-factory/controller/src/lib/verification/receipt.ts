import type { Receipt, Verdict } from "../domain/work-order.js"
import { ASSERTION_FAILURE, type SuiteEvent } from "./checks-runner.js"
import type { SuiteKind, SuiteSession } from "./grade-suite.js"
import { type VerifyMode, worstVerdict } from "./verifier.js"

/** The one place an evidence id is formed, so every check's reference is distinct by shape. */
export function evidenceRef(checkId: string, digest: string): { id: string; digest: string } {
  return { id: `${checkId}/output`, digest }
}

/**
 * One check as decided but not yet stored: its evidence is the text, not a digest.
 *
 * The split is what makes the decision testable. Choosing the verdict and the checks is pure
 * over the two sessions' outcomes; hashing the evidence into the artifact store is the only
 * part that needs I/O, and it is a uniform map the verifier applies afterwards.
 */
export interface PlannedCheck {
  readonly id: string
  readonly acceptanceIds: readonly string[]
  readonly verdict: Verdict
  /** Stored as-is under `${id}/output`. */
  readonly evidence: string
}

/** A receipt's verdict and checks, decided and ready to be stored. */
export interface ReceiptPlan {
  readonly verdict: Verdict
  readonly checks: readonly PlannedCheck[]
}

/**
 * Decide a receipt from the container sessions, in the order the verifier short-circuits.
 *
 * In `full` mode (the default) `visible` must have run. `independent` is null exactly when
 * session B was not started, which happens only because session A already decided the
 * verdict. In `independentOnly` mode there is no session A: `visible` must be null and
 * `independent` must have run, and a build failure is a fact about the bytes graded (there
 * is no earlier build to disagree with), so it is `fail`. A tamper is reported under its own
 * check id, `tamper`, never `independent`: the caller reads an `independent: fail` as a
 * failing assertion, and a check that mutated the workspace is not one. Anything else is a
 * bug in the caller and throws rather than inventing a verdict: a receipt is the one thing in
 * this system that must never be guessed.
 */
export function assembleReceipt(input: {
  readonly visible: SuiteSession | null
  readonly independent: SuiteSession | null
  readonly acceptanceIds: { readonly [K in SuiteKind]: readonly string[] }
  readonly mode?: VerifyMode
}): ReceiptPlan {
  const { visible, independent } = input
  if ((input.mode ?? "full") === "independentOnly") {
    if (visible) throw new Error("the visible session ran in independentOnly mode")
    if (!independent)
      throw new Error("the independent session did not run and no verdict was recorded")
    return independentOnlyPlan(independent, input.acceptanceIds.independent)
  }
  if (!visible) throw new Error("the visible session did not run and no verdict was recorded")

  // A build failure is a fact about the candidate, so it is a `fail` and not `inconclusive`.
  if (!visible.build.ok)
    return {
      verdict: "fail",
      checks: [{ id: "build", acceptanceIds: [], verdict: "fail", evidence: visible.build.output }],
    }

  if (visible.tampered) return tamper("visible", visible)

  if (!independent)
    throw new Error("the independent session did not run and no verdict was recorded")

  // The same build, from the same bytes, already succeeded in session A. If it fails here the
  // two containers disagreed, which is a fact about the harness and not about the candidate —
  // `inconclusive`, never `fail`. Grading it as a failure would let a flaky compiler reject a
  // correct repair.
  if (!independent.build.ok)
    return {
      verdict: "inconclusive",
      checks: [
        {
          id: "build",
          acceptanceIds: [],
          verdict: "inconclusive",
          evidence: `the build succeeded in the visible session and failed in the independent one\n${independent.build.output}`,
        },
      ],
    }

  if (independent.tampered) return tamper("independent", independent)

  const visibleResult = visible.result
  const independentResult = independent.result
  if (!visibleResult || !independentResult)
    throw new Error("a suite did not run and neither a build failure nor a tamper was recorded")

  return {
    verdict: worstVerdict([visibleResult.verdict, independentResult.verdict]),
    checks: [
      {
        id: "visible",
        acceptanceIds: [...input.acceptanceIds.visible],
        verdict: visibleResult.verdict,
        evidence: visibleResult.output,
      },
      {
        id: "independent",
        acceptanceIds: [...input.acceptanceIds.independent],
        verdict: independentResult.verdict,
        evidence: independentResult.output,
      },
    ],
  }
}

/** The independent suite alone: the same short-circuits as a session, over one session. */
function independentOnlyPlan(
  independent: SuiteSession,
  acceptanceIds: readonly string[],
): ReceiptPlan {
  if (!independent.build.ok)
    return {
      verdict: "fail",
      checks: [
        { id: "build", acceptanceIds: [], verdict: "fail", evidence: independent.build.output },
      ],
    }
  // Under its own id: an `independent: fail` reads as a failing assertion, and this is not one.
  if (independent.tampered) return tamper("independent", independent, "tamper")
  const result = independent.result
  if (!result)
    throw new Error("a suite did not run and neither a build failure nor a tamper was recorded")
  const unproven = result.verdict === "fail" ? unprovenFailure(result.events, acceptanceIds) : null
  const verdict: Verdict = unproven ? "inconclusive" : result.verdict
  return {
    verdict,
    checks: [
      {
        id: "independent",
        acceptanceIds: [...acceptanceIds],
        verdict,
        evidence: unproven ? `${unproven}\n${result.output}` : result.output,
      },
    ],
  }
}

/**
 * Why a failing independent-only run proves nothing, or null when it does. `independentOnly`
 * is the oracle proof, and a `fail` there is read as "the check fails on the defect", so it
 * must be a named assertion failing by assertion (`ERR_ASSERTION`), and nothing else failing:
 * - a file that cannot load (a missing module, a syntax error, a top-level throw) reports one
 *   failure named after the file, with no cause, and no named test runs at all;
 * - a failure under any other name is a test the check does not name;
 * - a named test that fails by a throw (`TypeError`, a missing export) has not asserted
 *   anything about the behaviour: it is how a placeholder or a wrong import fails.
 * The live run's first drafted check failed on `ERR_MODULE_NOT_FOUND` and was read as an
 * oracle. Full-mode grading is untouched: there a failure of any kind rejects the candidate.
 */
function unprovenFailure(
  events: readonly SuiteEvent[],
  assertions: readonly string[],
): string | null {
  const failed = events.filter((event) => event.type === "test:fail")
  const unnamed = failed.filter((event) => !assertions.includes(event.name))
  if (unnamed.length > 0)
    return `inconclusive: failures outside the named assertions prove nothing (the file may not have loaded): ${unnamed.map(describeFailure).join(", ")}`
  if (!failed.some((event) => event.failure === ASSERTION_FAILURE))
    return failed.length === 0
      ? "inconclusive: the suite failed but no named assertion ran and failed"
      : `inconclusive: no named assertion failed by assertion (${ASSERTION_FAILURE}): ${failed.map(describeFailure).join(", ")}`
  return null
}

const describeFailure = (event: SuiteEvent): string =>
  `${JSON.stringify(event.name)} (${event.failure ?? "no cause"})`

/**
 * The receipt a tampering candidate gets: one check, named for the session it happened in
 * unless the caller names it otherwise; the evidence always says which session it was.
 */
function tamper(kind: SuiteKind, session: SuiteSession, id: string = kind): ReceiptPlan {
  return {
    verdict: "fail",
    checks: [
      {
        id,
        acceptanceIds: [],
        verdict: "fail",
        evidence: `a suite mutated the workspace during ${kind}\n${session.result?.output ?? ""}`,
      },
    ],
  }
}

/** The plan for the verifier's own deadline: a fact about the harness, so `inconclusive`. */
export function deadlinePlan(deadlineMs: number): ReceiptPlan {
  return {
    verdict: "inconclusive",
    checks: [
      {
        id: "deadline",
        acceptanceIds: [],
        verdict: "inconclusive",
        evidence: `verification exceeded its ${deadlineMs}ms deadline`,
      },
    ],
  }
}

/**
 * The checks a passing or failing run of both suites reports, in the receipt's own order.
 *
 * Exported because it is the shape `freezeBundle` has to accept: a test that builds a
 * receipt by hand proves nothing about the receipt this verifier emits, and the Docker lane
 * is not always on. Layer 1 calls this and freezes the result, and also pins it against
 * {@link assembleReceipt}'s own both-suites-ran branch so the two cannot drift.
 */
export function suiteChecks(input: {
  readonly visible: SuiteEvidence
  readonly independent: SuiteEvidence
}): Receipt["checks"] {
  return [
    {
      id: "visible",
      acceptanceIds: [...input.visible.acceptanceIds],
      verdict: input.visible.verdict,
      evidence: [evidenceRef("visible", input.visible.outputDigest)],
    },
    {
      id: "independent",
      acceptanceIds: [...input.independent.acceptanceIds],
      verdict: input.independent.verdict,
      evidence: [evidenceRef("independent", input.independent.outputDigest)],
    },
  ]
}

/**
 * The one check an `independentOnly` run reports, in the shape `freezeBundle` accepts. The
 * fake verifier builds its independent-only receipts from this, so it cannot issue a receipt
 * the real verifier could not; {@link assembleReceipt}'s own branch is pinned against it.
 */
export function independentOnlyChecks(independent: SuiteEvidence): Receipt["checks"] {
  return [
    {
      id: "independent",
      acceptanceIds: [...independent.acceptanceIds],
      verdict: independent.verdict,
      evidence: [evidenceRef("independent", independent.outputDigest)],
    },
  ]
}

/** One suite's contribution to a receipt: its verdict, what it graded, and its output. */
export interface SuiteEvidence {
  readonly verdict: Receipt["verdict"]
  readonly acceptanceIds: readonly string[]
  readonly outputDigest: string
}
