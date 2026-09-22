import type { Receipt, Verdict } from "../domain/work-order.js"
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
 * is no earlier build to disagree with), so it is `fail`. Anything else is a bug in the caller
 * and throws rather than inventing a verdict: a receipt is the one thing in this system that
 * must never be guessed.
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
  if (independent.tampered) return tamper("independent", independent)
  const result = independent.result
  if (!result)
    throw new Error("a suite did not run and neither a build failure nor a tamper was recorded")
  return {
    verdict: result.verdict,
    checks: [
      {
        id: "independent",
        acceptanceIds: [...acceptanceIds],
        verdict: result.verdict,
        evidence: result.output,
      },
    ],
  }
}

/** The receipt a tampering candidate gets: one check, named for the session it happened in. */
function tamper(kind: SuiteKind, session: SuiteSession): ReceiptPlan {
  return {
    verdict: "fail",
    checks: [
      {
        id: kind,
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
