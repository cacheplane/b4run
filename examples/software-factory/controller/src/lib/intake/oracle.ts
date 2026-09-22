import type { Receipt, Verdict } from "../domain/work-order.js"
import type { Verifier } from "../verification/verifier.js"

export interface ProveOracleInput {
  readonly verifier: Verifier
  readonly workOrderId: string
  readonly taskId: string
  readonly policyDigest: string
  /** The captured baseline's digest: the receipt then names the bytes it graded, the unpatched pin. */
  readonly baselineDigest: string
  readonly signal: AbortSignal
}

export type OracleProof =
  | { readonly proven: true; readonly receipt: Receipt }
  | { readonly proven: false; readonly verdict: Verdict; readonly receipt: Receipt }

/**
 * A drafted check is an oracle only if it FAILS on the unpatched baseline: run the independent
 * suite alone, with no candidate changes, in the target's environment. `inconclusive` is not a
 * failure: a check that could not run proves nothing, and a check that passes on the defect
 * would pass on anything. A receipt with no `independent` check (the baseline did not build,
 * the deadline fired) is read the same way, whatever its own verdict says: the check never
 * ran. Rejects only when the harness itself could not run.
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
  const verdict =
    receipt.checks.find((check) => check.id === "independent")?.verdict ?? "inconclusive"
  return verdict === "fail" ? { proven: true, receipt } : { proven: false, verdict, receipt }
}
