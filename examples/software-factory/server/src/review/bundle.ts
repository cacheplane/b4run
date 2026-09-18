import { bundleDigest } from "../domain/digest.js"
import type { Bundle, Receipt } from "../domain/work-order.js"

export interface FreezeBundleInput {
  readonly workOrderId: string
  readonly repositoryId: string
  readonly baselineDigest: string
  readonly specificationDigest: string
  readonly policyDigest: string
  readonly candidateDigest: string
  readonly receipt: Receipt
  readonly destinationId: string
  readonly frozenAt: string
}

/**
 * Freeze everything approval will authorize. A bundle is only frozen over a
 * passing receipt for this exact candidate: a failing or inconclusive verdict has
 * nothing to approve, and a receipt for other bytes would make consent a guess.
 */
export function freezeBundle(input: FreezeBundleInput): Bundle {
  if (input.receipt.verdict !== "pass")
    throw new Error(`Cannot freeze a bundle over a ${input.receipt.verdict} receipt; it must pass`)
  if (input.receipt.candidateDigest !== input.candidateDigest)
    throw new Error("Receipt is for a different candidate than the one being frozen")

  const evidenceById = new Map<string, string>()
  for (const check of input.receipt.checks) {
    for (const item of check.evidence) {
      const existing = evidenceById.get(item.id)
      if (existing !== undefined && existing !== item.digest) {
        throw new Error(`Receipt reports conflicting evidence for "${item.id}"`)
      }
      evidenceById.set(item.id, item.digest)
    }
  }
  const evidence = [...evidenceById.entries()]
    .map(([id, digest]) => ({ id, digest }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))

  const payload = {
    workOrderId: input.workOrderId,
    repositoryId: input.repositoryId,
    baselineDigest: input.baselineDigest,
    specificationDigest: input.specificationDigest,
    policyDigest: input.policyDigest,
    environmentIdentity: input.receipt.environmentIdentity,
    candidateDigest: input.candidateDigest,
    evidence,
    operation: "export-local" as const,
    destinationId: input.destinationId,
  }

  return {
    digest: bundleDigest(payload),
    workOrderId: input.workOrderId,
    candidateDigest: input.candidateDigest,
    receiptId: input.receipt.id,
    payload,
    frozenAt: input.frozenAt,
  }
}
