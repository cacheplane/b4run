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
  const getReceipt = (id: string): Receipt | null => {
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
          checks: JSON.parse(String(row.checks)),
          issuedAt: row.issued_at,
        })
      : null
  }

  const getBundle = (digest: string): Bundle | null => {
    const row = db.prepare("SELECT * FROM bundles WHERE digest = ?").get(digest) as
      | Record<string, string>
      | undefined
    return row
      ? BundleSchema.parse({
          digest: row.digest,
          workOrderId: row.work_order_id,
          candidateDigest: row.candidate_digest,
          receiptId: row.receipt_id,
          payload: JSON.parse(String(row.payload)),
          frozenAt: row.frozen_at,
        })
      : null
  }

  return {
    // `digest` is a hash over the record's own content, so "same key, different
    // content" cannot happen without a sha256 collision: INSERT OR IGNORE is safe.
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
    // `id` is caller-supplied, not derived from the content, so a second call
    // reusing an id with a different verdict or checks is a genuine conflict,
    // not a hash collision: it must be detected rather than silently ignored,
    // because the verdict is the one thing this store cannot get wrong.
    recordReceipt(receipt) {
      const parsed = ReceiptSchema.parse(receipt)
      const existing = getReceipt(parsed.id)
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(parsed)) return
        throw new Error(`Recorded receipt ${parsed.id} differs from the one already stored`)
      }
      db.prepare(
        `INSERT INTO receipts
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
      return getReceipt(id)
    },
    // `freezeBundle` digests the whole record, receipt id and freeze time included, so a
    // repeated digest should be a repeated bundle. That is checked rather than assumed: the
    // store cannot see who computed the digest, and a same-digest record naming a different
    // receipt would otherwise be dropped on the floor, leaving the row's journal and the
    // evidence view naming different receipts.
    recordBundle(bundle) {
      const parsed = BundleSchema.parse(bundle)
      const existing = getBundle(parsed.digest)
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(parsed)) return
        throw new Error(`Recorded bundle ${parsed.digest} differs from the one already stored`)
      }
      db.prepare(
        `INSERT INTO bundles
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
      return getBundle(digest)
    },
  }
}
