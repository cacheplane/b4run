import type { Receipt, Verdict } from "../domain/work-order.js"

export interface VerifyInput {
  readonly workOrderId: string
  readonly taskId: string
  readonly candidateDigest: string
  readonly changes: Readonly<Record<string, string>>
  readonly policyDigest: string
}

/**
 * Runs the completion policy against a candidate and issues a receipt. The
 * implementation, not the caller, assigns the verifier identity and the
 * environment identity, because those are the claims a receipt is trusted for.
 *
 * `verify` resolves with a receipt for every outcome the policy can reach,
 * including `fail` and `inconclusive`. It rejects only when the harness itself
 * could not run, which the controller records separately from a verdict.
 */
export interface Verifier {
  verify(input: VerifyInput, signal: AbortSignal): Promise<Receipt>
}

/** Convenience for implementations: a receipt's verdict is the worst of its checks. */
export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("fail")) return "fail"
  if (verdicts.includes("inconclusive")) return "inconclusive"
  return "pass"
}
