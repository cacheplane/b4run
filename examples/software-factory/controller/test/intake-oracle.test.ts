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

/** A receipt the fake cannot issue, built by hand with the checks named. */
const inline = (checks: readonly { id: string; verdict: Receipt["verdict"] }[]): Receipt => ({
  id: "rc-inline",
  workOrderId: "wo-1",
  candidateDigest: baselineDigest,
  verifierIdentity: "inline:test",
  policyDigest: "b".repeat(64),
  environmentIdentity: "inline:none",
  issuedAt: new Date().toISOString(),
  verdict: checks.some((c) => c.verdict === "fail") ? "fail" : "inconclusive",
  checks: checks.map((c) => ({
    id: c.id,
    acceptanceIds: [],
    verdict: c.verdict,
    evidence: [{ id: `${c.id}/output`, digest: "d".repeat(64) }],
  })),
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

  it("is not proven when the check passes on the defect, and names the independent check", async () => {
    const proof = await prove(createFakeVerifier({ independent: "pass" }))
    expect(proof).toMatchObject({ proven: false, verdict: "pass", checkId: "independent" })
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

  it("is not proven by a build failure on the baseline, and names the build check", async () => {
    // A `fail` receipt whose only check is `build`: the check never ran. Reading the receipt
    // verdict would prove it.
    const receipt = inline([{ id: "build", verdict: "fail" }])
    const proof = await prove({ verify: async () => receipt })
    expect(proof).toMatchObject({ proven: false, verdict: "fail", checkId: "build" })
    expect(proof.receipt).toBe(receipt)
  })

  it("is not proven by a check that mutated the workspace, and names the tamper check", async () => {
    // A tampering check must never become an oracle: its `fail` is the tamper, not an assertion.
    const receipt = inline([{ id: "tamper", verdict: "fail" }])
    const proof = await prove({ verify: async () => receipt })
    expect(proof).toMatchObject({ proven: false, verdict: "fail", checkId: "tamper" })
  })

  it("is inconclusive with no deciding check when the receipt carries none", async () => {
    const proof = await prove({ verify: async () => inline([]) })
    expect(proof).toMatchObject({ proven: false, verdict: "inconclusive", checkId: null })
  })

  it("refuses a receipt that names bytes other than the baseline", async () => {
    // A receipt is never guessed, and neither is what it graded: a verifier that answered for
    // some other candidate cannot prove anything about the baseline.
    const other = "e".repeat(64)
    const receipt = { ...inline([{ id: "independent", verdict: "fail" }]), candidateDigest: other }
    await expect(prove({ verify: async () => receipt })).rejects.toThrow(
      `the verifier issued a receipt for ${other}, not the baseline ${baselineDigest} it was asked to grade`,
    )
  })
})
