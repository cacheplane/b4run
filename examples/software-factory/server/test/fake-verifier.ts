import { randomUUID } from "node:crypto"
import type { Verdict } from "../src/domain/work-order.ts"
import { type Verifier, type VerifyInput, worstVerdict } from "../src/verification/verifier.ts"

export interface FakeVerifierScript {
  /** The receipt verdict. Defaults to the worst of the two suite verdicts. */
  readonly verdict?: Verdict
  readonly visible?: Verdict
  readonly independent?: Verdict
  /** When set, `verify` rejects with this message instead of issuing a receipt. */
  readonly throws?: string
  /** Fixed receipt id, for tests that need two receipts to collide in the registry. */
  readonly receiptId?: string
}

export interface FakeVerifier extends Verifier {
  /** Candidate digests this verifier was asked to verify, in order. */
  readonly verified: string[]
  script: FakeVerifierScript
}

/**
 * Scripted stand-in for the real container. The framework's `fakeSandbox` cannot
 * serve here: it has no managed-workspace member, so `withWorkspace` refuses it,
 * and no leaf metadata, so `inspectWorkspace` throws. Layers 1 and 2 therefore
 * choose the verdict and assert the controller's response to it; only the
 * Docker-gated layer proves a verdict was earned.
 */
export function createFakeVerifier(script: FakeVerifierScript): FakeVerifier {
  const verified: string[] = []
  const fake: FakeVerifier = {
    verified,
    script,
    async verify(input: VerifyInput) {
      verified.push(input.candidateDigest)
      if (fake.script.throws) throw new Error(fake.script.throws)
      const visible = fake.script.visible ?? fake.script.verdict ?? "pass"
      const independent = fake.script.independent ?? fake.script.verdict ?? "pass"
      return {
        id: fake.script.receiptId ?? `rc-${randomUUID()}`,
        workOrderId: input.workOrderId,
        candidateDigest: input.candidateDigest,
        verifierIdentity: `fake:${fake.script.verdict ?? worstVerdict([visible, independent])}`,
        policyDigest: input.policyDigest,
        environmentIdentity: "fake:none",
        verdict: fake.script.verdict ?? worstVerdict([visible, independent]),
        checks: [
          { id: "visible", acceptanceIds: ["visible"], verdict: visible, evidence: [] },
          { id: "independent", acceptanceIds: ["independent"], verdict: independent, evidence: [] },
        ],
        issuedAt: new Date().toISOString(),
      }
    },
  }
  return fake
}
