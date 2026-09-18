import type { DatabaseSync } from "node:sqlite"
import {
  type Bundle,
  BundleSchema,
  type Candidate,
  CandidateSchema,
  type Receipt,
  ReceiptSchema,
} from "../domain/work-order.js"

export interface EvidenceStore {
  recordCandidate(candidate: Candidate): void
  candidate(digest: string): Candidate | null
  recordReceipt(receipt: Receipt): void
  receipt(id: string): Receipt | null
  recordBundle(bundle: Bundle): void
  bundle(digest: string): Bundle | null
}

/**
 * The immutable half of the registry. Every record is keyed by its own identity,
 * so recording the same evidence twice is a no-op rather than a conflict, which
 * is what makes the verifying phase safe to replay after a restart.
 */
export function createEvidenceStore(db: DatabaseSync): EvidenceStore {
  return {
    recordCandidate(candidate) {
      CandidateSchema.parse(candidate)
      db.prepare(
        `INSERT OR IGNORE INTO candidates
         (digest, work_order_id, baseline_digest, changed_paths, bytes, artifact_digest, assembled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        candidate.digest,
        candidate.workOrderId,
        candidate.baselineDigest,
        JSON.stringify(candidate.changedPaths),
        candidate.bytes,
        candidate.artifactDigest,
        candidate.assembledAt,
      )
    },
    candidate(digest) {
      const row = db.prepare("SELECT * FROM candidates WHERE digest = ?").get(digest) as
        | Record<string, string | number>
        | undefined
      return row
        ? CandidateSchema.parse({
            digest: row.digest,
            workOrderId: row.work_order_id,
            baselineDigest: row.baseline_digest,
            changedPaths: JSON.parse(String(row.changed_paths)),
            bytes: row.bytes,
            artifactDigest: row.artifact_digest,
            assembledAt: row.assembled_at,
          })
        : null
    },
    recordReceipt(receipt) {
      ReceiptSchema.parse(receipt)
      db.prepare(
        `INSERT OR IGNORE INTO receipts
         (id, work_order_id, candidate_digest, verifier_identity, policy_digest,
          environment_identity, verdict, checks, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        receipt.id,
        receipt.workOrderId,
        receipt.candidateDigest,
        receipt.verifierIdentity,
        receipt.policyDigest,
        receipt.environmentIdentity,
        receipt.verdict,
        JSON.stringify(receipt.checks),
        receipt.issuedAt,
      )
    },
    receipt(id) {
      const row = db.prepare("SELECT * FROM receipts WHERE id = ?").get(id) as
        | Record<string, string>
        | undefined
      return row
        ? ReceiptSchema.parse({
            id: row.id,
            workOrderId: row.work_order_id,
            candidateDigest: row.candidate_digest,
            verifierIdentity: row.verifier_identity,
            policyDigest: row.policy_digest,
            environmentIdentity: row.environment_identity,
            verdict: row.verdict,
            checks: JSON.parse(row.checks),
            issuedAt: row.issued_at,
          })
        : null
    },
    recordBundle(bundle) {
      BundleSchema.parse(bundle)
      db.prepare(
        `INSERT OR IGNORE INTO bundles
         (digest, work_order_id, candidate_digest, receipt_id, payload, frozen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        bundle.digest,
        bundle.workOrderId,
        bundle.candidateDigest,
        bundle.receiptId,
        JSON.stringify(bundle.payload),
        bundle.frozenAt,
      )
    },
    bundle(digest) {
      const row = db.prepare("SELECT * FROM bundles WHERE digest = ?").get(digest) as
        | Record<string, string>
        | undefined
      return row
        ? BundleSchema.parse({
            digest: row.digest,
            workOrderId: row.work_order_id,
            candidateDigest: row.candidate_digest,
            receiptId: row.receipt_id,
            payload: JSON.parse(row.payload),
            frozenAt: row.frozen_at,
          })
        : null
    },
  }
}
