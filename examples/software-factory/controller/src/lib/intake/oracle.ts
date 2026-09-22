import type { Receipt, Verdict } from "../domain/work-order.js"
import type { Verifier } from "../verification/verifier.js"

export interface ProveOracleInput {
  readonly verifier: Verifier
  readonly workOrderId: string
  readonly taskId: string
  readonly policyDigest: string
  /**
   * The captured baseline's digest: the receipt then names the bytes it graded, the unpatched
   * pin. A receipt naming any other digest is refused.
   */
  readonly baselineDigest: string
  readonly signal: AbortSignal
}

export type OracleProof =
  | { readonly proven: true; readonly receipt: Receipt }
  | {
      readonly proven: false
      readonly verdict: Verdict
      /** The check that decided (`build`, `tamper`, `independent`, ...), or null with none. */
      readonly checkId: string | null
      readonly receipt: Receipt
    }

/**
 * A drafted check is an oracle only if it FAILS on the unpatched baseline: run the independent
 * suite alone, with no candidate changes, in the target's environment. Proven iff the receipt
 * carries an `independent` check with verdict exactly `fail`. `inconclusive` is not a
 * failure: a check that could not run proves nothing, and a check that passes on the defect
 * would pass on anything. A `fail` under any other check id is not a failing assertion
 * either: a tamper (`tamper`) or a build failure (`build`) proves nothing about the defect,
 * whatever the receipt's own verdict says. The not-proven arm names the deciding check so the
 * caller can journal why. Rejects when the harness itself could not run, and when the receipt
 * names bytes other than the baseline it was asked to grade: a receipt is never guessed.
 */
export async function proveOracle(input: ProveOracleInput): Promise<OracleProof> {
  const receipt = await input.verifier.verify(
    {
      workOrderId: input.workOrderId,
      taskId: input.taskId,
      candidateDigest: input.baselineDigest,
      changes: {},
      policyDigest: input.policyDigest,
      mode: "independentOnly",
    },
    input.signal,
  )
  if (receipt.candidateDigest !== input.baselineDigest)
    throw new Error(
      `the verifier issued a receipt for ${receipt.candidateDigest}, not the baseline ${input.baselineDigest} it was asked to grade`,
    )
  const independent = receipt.checks.find((check) => check.id === "independent")
  if (independent?.verdict === "fail") return { proven: true, receipt }
  const decided = independent ?? receipt.checks[0] ?? null
  return {
    proven: false,
    verdict: decided?.verdict ?? "inconclusive",
    checkId: decided?.id ?? null,
    receipt,
  }
}
