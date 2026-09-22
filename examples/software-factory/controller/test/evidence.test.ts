import { describe, expect, it } from "vitest"
import { openRegistry } from "../src/lib/registry/db.ts"
import { createEvidenceStore } from "../src/lib/registry/evidence.ts"
import { createWorkOrderStore } from "../src/lib/registry/work-orders.ts"

const at = "2026-09-18T00:00:00.000Z"

function stores() {
  const db = openRegistry(":memory:").db
  const workOrders = createWorkOrderStore(db)
  workOrders.insert({
    id: "wo-1",
    revision: 0,
    state: "received",
    taskId: "cli-flags",
    workerRoute: "/build#agent",
    workerThreadId: null,
    interruptId: null,
    candidateDigest: null,
    bundleDigest: null,
    blockedReason: null,
    failureReason: null,
    maxCandidateAttempts: 1,
    maxActiveMs: 60_000,
    activeMs: 0,
    activeStartedAt: null,
    awaitingSince: null,
    createdAt: at,
    updatedAt: at,
  })
  return { evidence: createEvidenceStore(db), workOrders }
}

describe("evidence store", () => {
  it("round-trips a candidate, a receipt and a bundle", () => {
    const { evidence } = stores()
    const candidate = {
      digest: "a".repeat(64),
      workOrderId: "wo-1",
      baselineDigest: "b".repeat(64),
      changedPaths: ["src/cli.ts"],
      bytes: 10,
      artifactDigest: "c".repeat(64),
      assembledAt: at,
    }
    evidence.recordCandidate(candidate)
    expect(evidence.candidate(candidate.digest)).toEqual(candidate)

    const receipt = {
      id: "rc-1",
      workOrderId: "wo-1",
      candidateDigest: candidate.digest,
      verifierIdentity: "docker:sha256:abc",
      policyDigest: "d".repeat(64),
      environmentIdentity: "sha256:abc",
      verdict: "pass" as const,
      checks: [{ id: "visible", acceptanceIds: ["one"], verdict: "pass" as const, evidence: [] }],
      issuedAt: at,
    }
    evidence.recordReceipt(receipt)
    expect(evidence.receipt("rc-1")).toEqual(receipt)

    const bundle = {
      digest: "e".repeat(64),
      workOrderId: "wo-1",
      candidateDigest: candidate.digest,
      receiptId: "rc-1",
      payload: { repositoryId: "cli-flags" },
      frozenAt: at,
    }
    evidence.recordBundle(bundle)
    expect(evidence.bundle(bundle.digest)).toEqual(bundle)
  })

  it("refuses a different bundle reusing the same digest, and leaves the stored one unchanged", () => {
    // `recordBundle` used to INSERT OR IGNORE on the strength of "the digest covers the
    // record's content". It did not cover `receiptId` or `frozenAt`, so a bundle re-frozen
    // over a later receipt kept the first receipt id, and the evidence view showed a receipt
    // the row's journal never issued. A repeated digest with different content is a defect
    // to surface, exactly as it is for receipts.
    const { evidence } = stores()
    evidence.recordReceipt({
      id: "rc-1",
      workOrderId: "wo-1",
      candidateDigest: "a".repeat(64),
      verifierIdentity: "docker:sha256:abc",
      policyDigest: "d".repeat(64),
      environmentIdentity: "sha256:abc",
      verdict: "pass" as const,
      checks: [{ id: "visible", acceptanceIds: ["one"], verdict: "pass" as const, evidence: [] }],
      issuedAt: at,
    })
    const bundle = {
      digest: "e".repeat(64),
      workOrderId: "wo-1",
      candidateDigest: "a".repeat(64),
      receiptId: "rc-1",
      payload: { repositoryId: "cli-flags" },
      frozenAt: at,
    }
    evidence.recordBundle(bundle)
    evidence.recordBundle(bundle)
    expect(() => evidence.recordBundle({ ...bundle, receiptId: "rc-2" })).toThrow(/e{64}/)
    expect(evidence.bundle(bundle.digest)).toEqual(bundle)
  })

  it("returns null for anything it has not recorded", () => {
    const { evidence } = stores()
    expect(evidence.candidate("f".repeat(64))).toBeNull()
    expect(evidence.receipt("nope")).toBeNull()
    expect(evidence.bundle("f".repeat(64))).toBeNull()
  })

  it("is idempotent on a repeated identical record", () => {
    const { evidence } = stores()
    const candidate = {
      digest: "a".repeat(64),
      workOrderId: "wo-1",
      baselineDigest: "b".repeat(64),
      changedPaths: ["src/cli.ts"],
      bytes: 10,
      artifactDigest: "c".repeat(64),
      assembledAt: at,
    }
    evidence.recordCandidate(candidate)
    evidence.recordCandidate(candidate)
    expect(evidence.candidate(candidate.digest)).toEqual(candidate)
  })

  it("recording an identical receipt twice under the same id is a no-op", () => {
    const { evidence } = stores()
    const receipt = {
      id: "rc-1",
      workOrderId: "wo-1",
      candidateDigest: "a".repeat(64),
      verifierIdentity: "docker:sha256:abc",
      policyDigest: "d".repeat(64),
      environmentIdentity: "sha256:abc",
      verdict: "pass" as const,
      checks: [{ id: "visible", acceptanceIds: ["one"], verdict: "pass" as const, evidence: [] }],
      issuedAt: at,
    }
    evidence.recordReceipt(receipt)
    evidence.recordReceipt(receipt)
    expect(evidence.receipt(receipt.id)).toEqual(receipt)
  })

  it("refuses a different receipt reusing the same id, and leaves the stored one unchanged", () => {
    const { evidence } = stores()
    const receipt = {
      id: "rc-1",
      workOrderId: "wo-1",
      candidateDigest: "a".repeat(64),
      verifierIdentity: "docker:sha256:abc",
      policyDigest: "d".repeat(64),
      environmentIdentity: "sha256:abc",
      verdict: "pass" as const,
      checks: [{ id: "visible", acceptanceIds: ["one"], verdict: "pass" as const, evidence: [] }],
      issuedAt: at,
    }
    evidence.recordReceipt(receipt)

    const conflicting = { ...receipt, verdict: "fail" as const }
    expect(() => evidence.recordReceipt(conflicting)).toThrow(/rc-1/)
    expect(evidence.receipt(receipt.id)).toEqual(receipt)
  })
})
