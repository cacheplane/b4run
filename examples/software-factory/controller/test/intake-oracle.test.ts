import { describe, expect, it } from "vitest"
import type { Receipt } from "../src/lib/domain/work-order.ts"
import { proveOracle } from "../src/lib/intake/oracle.ts"
import type { Verifier, VerifyInput } from "../src/lib/verification/verifier.ts"
import { createFakeVerifier } from "./fake-verifier.ts"

/**
 * A drafted check is an oracle only if it fails on the unpatched baseline. The proof runs
 * the independent suite alone with no candidate changes; anything but exactly `fail` is not
 * a proof, and `inconclusive` least of all.
 */
const baselineDigest = "c".repeat(64)
const prove = (verifier: Verifier) =>
  proveOracle({
    verifier,
    workOrderId: "wo-1",
    taskId: "cli-flags",
    policyDigest: "b".repeat(64),
    baselineDigest,
    signal: AbortSignal.timeout(1_000),
  })

describe("proveOracle", () => {
  it("is proven when the independent suite fails on the baseline, and asks for exactly that run", async () => {
    const verifier = createFakeVerifier({ independent: "fail" })
    const proof = await prove(verifier)
    expect(proof.proven).toBe(true)
    expect(proof.receipt.verdict).toBe("fail")
    expect(verifier.calls).toHaveLength(1)
    const call = verifier.calls[0] as VerifyInput
    expect(call.mode).toBe("independentOnly")
    expect(call.changes).toEqual({})
    expect(call.candidateDigest).toBe(baselineDigest)
    expect(call.workOrderId).toBe("wo-1")
    expect(call.taskId).toBe("cli-flags")
    expect(call.policyDigest).toBe("b".repeat(64))
  })

  it("is not proven when the check passes on the defect", async () => {
    const proof = await prove(createFakeVerifier({ independent: "pass" }))
    expect(proof).toMatchObject({ proven: false, verdict: "pass" })
    expect(proof.receipt.verdict).toBe("pass")
  })

  it("is not proven when the check could not run", async () => {
    const proof = await prove(createFakeVerifier({ independent: "inconclusive" }))
    expect(proof).toMatchObject({ proven: false, verdict: "inconclusive" })
  })

  it("rejects when the harness itself could not run", async () => {
    await expect(prove(createFakeVerifier({ throws: "docker down" }))).rejects.toThrow(
      /docker down/,
    )
  })

  it("is inconclusive, not proven, when the receipt carries no independent check", async () => {
    // A build failure on the baseline is a `fail` receipt with only a `build` check. That is
    // not the check failing; the check never ran. Reading the receipt verdict would prove it.
    const receipt: Receipt = {
      id: "rc-build",
      workOrderId: "wo-1",
      candidateDigest: baselineDigest,
      verifierIdentity: "inline:test",
      policyDigest: "b".repeat(64),
      environmentIdentity: "inline:none",
      issuedAt: new Date().toISOString(),
      verdict: "fail",
      checks: [
        {
          id: "build",
          acceptanceIds: [],
          verdict: "fail",
          evidence: [{ id: "build/output", digest: "d".repeat(64) }],
        },
      ],
    }
    const verifier: Verifier = { verify: async () => receipt }
    const proof = await prove(verifier)
    expect(proof).toMatchObject({ proven: false, verdict: "inconclusive" })
    expect(proof.receipt).toBe(receipt)
  })
})
