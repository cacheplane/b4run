import { describe, expect, it } from "vitest"
import { freezeBundle } from "../src/review/bundle.ts"
import { loadPolicy } from "../src/verification/policy.ts"

const receipt = {
  id: "rc-1",
  workOrderId: "wo-1",
  candidateDigest: "a".repeat(64),
  verifierIdentity: "docker:sha256:abc",
  policyDigest: "b".repeat(64),
  environmentIdentity: "sha256:abc",
  verdict: "pass" as const,
  checks: [
    { id: "visible", acceptanceIds: ["one"], verdict: "pass" as const, evidence: [] },
    {
      id: "independent",
      acceptanceIds: ["two"],
      verdict: "pass" as const,
      evidence: [{ id: "independent-output", digest: "c".repeat(64) }],
    },
  ],
  issuedAt: "2026-09-18T00:00:00.000Z",
}

describe("loadPolicy", () => {
  it("derives the specification and policy digests from fixture data", () => {
    const policy = loadPolicy("cli-flags")
    expect(policy.specificationDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.policyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.acceptanceIds.length).toBeGreaterThan(0)
    expect(policy.allowedSourcePaths).toEqual(["src/cli.ts"])
  })

  it("moves the policy digest when the inventory changes, and not otherwise", () => {
    const one = loadPolicy("cli-flags")
    const two = loadPolicy("cli-flags")
    expect(two.policyDigest).toBe(one.policyDigest)
  })
})

describe("freezeBundle", () => {
  const base = {
    workOrderId: "wo-1",
    repositoryId: "cli-flags",
    baselineDigest: "d".repeat(64),
    specificationDigest: "e".repeat(64),
    policyDigest: receipt.policyDigest,
    candidateDigest: receipt.candidateDigest,
    receipt,
    destinationId: "/out",
    frozenAt: "2026-09-18T00:00:01.000Z",
  }

  it("freezes a bundle whose digest covers every input", () => {
    const bundle = freezeBundle(base)
    expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.candidateDigest).toBe(receipt.candidateDigest)
    expect(bundle.receiptId).toBe("rc-1")
    expect(bundle.payload.environmentIdentity).toBe("sha256:abc")
    expect(bundle.payload.operation).toBe("export-local")
  })

  it("carries the evidence the receipt referenced, sorted", () => {
    const bundle = freezeBundle(base)
    expect(bundle.payload.evidence).toEqual([{ id: "independent-output", digest: "c".repeat(64) }])
  })

  it("moves the digest when the policy or the environment moves, with identical bytes", () => {
    const one = freezeBundle(base)
    expect(freezeBundle({ ...base, policyDigest: "0".repeat(64) }).digest).not.toBe(one.digest)
    expect(
      freezeBundle({ ...base, receipt: { ...receipt, environmentIdentity: "sha256:other" } })
        .digest,
    ).not.toBe(one.digest)
  })

  it("refuses to freeze anything but a passing receipt", () => {
    expect(() => freezeBundle({ ...base, receipt: { ...receipt, verdict: "fail" } })).toThrow(
      /pass/,
    )
    expect(() =>
      freezeBundle({ ...base, receipt: { ...receipt, verdict: "inconclusive" } }),
    ).toThrow(/pass/)
  })

  it("refuses a receipt for a different candidate", () => {
    expect(() => freezeBundle({ ...base, candidateDigest: "9".repeat(64) })).toThrow(/candidate/)
  })
})
