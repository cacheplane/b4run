import { createHash, randomUUID } from "node:crypto"
import type { Verdict } from "../src/lib/domain/work-order.ts"
import { suiteChecks } from "../src/lib/verification/receipt.ts"
import { type Verifier, type VerifyInput, worstVerdict } from "../src/lib/verification/verifier.ts"

export interface FakeVerifierScript {
  /** The receipt verdict. Defaults to the worst of the two suite verdicts. */
  readonly verdict?: Verdict
  readonly visible?: Verdict
  readonly independent?: Verdict
  /** When set, `verify` rejects with this message instead of issuing a receipt. */
  readonly throws?: string
  /** Fixed receipt id, for tests that need two receipts to collide in the registry. */
  readonly receiptId?: string
  /**
   * The environment the receipt claims it ran in. Mutable between calls so a test can make
   * a re-verification report a different environment than the frozen bundle bound.
   */
  readonly environmentIdentity?: string
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
        environmentIdentity: fake.script.environmentIdentity ?? "fake:none",
        verdict: fake.script.verdict ?? worstVerdict([visible, independent]),
        // Built by the real verifier's own helper, so the fake cannot be weaker than the
        // thing it stands in for: distinct evidence ids per check, which is what
        // `freezeBundle` requires and what an empty evidence array used to hide.
        checks: suiteChecks({
          visible: {
            verdict: visible,
            acceptanceIds: ["visible"],
            outputDigest: outputDigest(input.candidateDigest, "visible", visible),
          },
          independent: {
            verdict: independent,
            acceptanceIds: ["independent"],
            outputDigest: outputDigest(input.candidateDigest, "independent", independent),
          },
        }),
        issuedAt: new Date().toISOString(),
      }
    },
  }
  return fake
}

/**
 * A stand-in for the digest of a suite's output. Content-addressed like the real one — the
 * same candidate and suite always yield the same digest, and two suites never share one —
 * so a receipt the fake issues twice is byte-identical, which the receipt registry requires.
 */
const outputDigest = (candidateDigest: string, checkId: string, verdict: Verdict): string =>
  createHash("sha256").update(`${candidateDigest}:${checkId}:${verdict}`).digest("hex")
