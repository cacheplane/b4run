import { z } from "zod"
import { bundleDigest } from "../domain/digest.js"
import type { Bundle, Origin, Receipt } from "../domain/work-order.js"
import {
  BRANCH_PATTERN,
  COMMIT_PATTERN,
  DIGEST_PATTERN,
  FACTORY_BRANCH,
  OriginSchema,
  REPOSITORY_PATTERN,
} from "../domain/work-order.js"

/**
 * What the frozen payload asserts, as a shape something can read back.
 *
 * A bundle is stored as an opaque record, which is how the payload came to be write-only:
 * nothing read it, so nothing noticed that `approve` re-verified under whatever policy and
 * environment happened to be current rather than the ones consent was given for. Approval
 * parses the payload with this and compares field by field.
 */
const ExportLocalPayloadSchema = z.object({
  workOrderId: z.string().min(1),
  repositoryId: z.string().min(1),
  baselineDigest: z.string().regex(DIGEST_PATTERN),
  specificationDigest: z.string().regex(DIGEST_PATTERN),
  policyDigest: z.string().regex(DIGEST_PATTERN),
  environmentIdentity: z.string().min(1),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  evidence: z.array(z.object({ id: z.string().min(1), digest: z.string().regex(DIGEST_PATTERN) })),
  operation: z.literal("export-local"),
  destinationId: z.string().min(1),
  // Both are in the digested payload so the digest covers the whole record, which is what
  // lets the registry treat a repeated digest as a repeated bundle: two freezes over two
  // receipts for the same claim are two bundles, each naming the receipt it was earned by.
  receiptId: z.string().min(1),
  frozenAt: z.string().min(1),
  // Where the work order came from and what it was drafted into: approving the export
  // consents to the issue text (its digest is in the origin), the approved generated task
  // and the candidate together. All four are stated for a catalog work order too (`null`),
  // so their absence is digested rather than merely omitted.
  origin: OriginSchema,
  pin: z.string().regex(COMMIT_PATTERN).nullable(),
  taskDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  /** The receipt that proved the drafted check fails on the unpatched baseline. */
  oracleReceiptId: z.string().min(1).nullable(),
})

/**
 * Where a draft-PR bundle publishes, digested with everything else (rung 4 spec §3.3): the
 * person who approves the bundle approves exactly this repository, base, branch and path
 * prefix, at the payload's own `pin`. Changing any of them needs a new bundle.
 */
export const DraftPrBundleDeliverySchema = z
  .object({
    repository: z.string().regex(REPOSITORY_PATTERN),
    baseBranch: z.string().regex(BRANCH_PATTERN),
    branch: z.string().regex(FACTORY_BRANCH),
    pathPrefix: z.string().min(1),
    issueStateAtCreate: z.enum(["open", "closed"]),
  })
  .strict()
export type DraftPrBundleDelivery = z.infer<typeof DraftPrBundleDeliverySchema>

const DraftPrPayloadSchema = ExportLocalPayloadSchema.extend({
  operation: z.literal("draft-pr"),
  delivery: DraftPrBundleDeliverySchema,
  // An issue work order has a pin; a draft-PR bundle without one has nothing to branch at.
  pin: z.string().regex(COMMIT_PATTERN),
})

/**
 * The two operations a bundle can authorize. `export-local` is exactly the payload every
 * bundle before rung 4 was frozen with, field for field, so each still parses and digests to
 * the digest it was frozen under.
 */
export const BundlePayloadSchema = z.discriminatedUnion("operation", [
  ExportLocalPayloadSchema,
  DraftPrPayloadSchema,
])
export type BundlePayload = z.infer<typeof BundlePayloadSchema>
export type DraftPrBundlePayload = z.infer<typeof DraftPrPayloadSchema>

/** A draft-PR bundle's destination identity: one repository, one branch. */
export function draftPrDestinationId(
  delivery: Pick<DraftPrBundleDelivery, "repository" | "branch">,
): string {
  return `github:${delivery.repository}:refs/heads/${delivery.branch}`
}

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
  readonly origin: Origin
  readonly pin: string | null
  readonly taskDigest: string | null
  readonly oracleReceiptId: string | null
  /**
   * Present: the bundle authorizes a draft pull request (`operation: "draft-pr"`) and its
   * `destinationId` is derived from this, not taken from `destinationId`. Absent: today's
   * export, byte for byte.
   */
  readonly delivery?: DraftPrBundleDelivery
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

  const common = {
    workOrderId: input.workOrderId,
    repositoryId: input.repositoryId,
    baselineDigest: input.baselineDigest,
    specificationDigest: input.specificationDigest,
    policyDigest: input.policyDigest,
    environmentIdentity: input.receipt.environmentIdentity,
    candidateDigest: input.candidateDigest,
    evidence,
    receiptId: input.receipt.id,
    frozenAt: input.frozenAt,
    origin: input.origin,
    pin: input.pin,
    taskDigest: input.taskDigest,
    oracleReceiptId: input.oracleReceiptId,
  }
  // An export-local payload carries no `delivery` key at all: adding one, even empty, would
  // move the digest of every bundle a local export freezes.
  let payload: BundlePayload
  if (input.delivery === undefined)
    payload = { ...common, operation: "export-local", destinationId: input.destinationId }
  else {
    if (input.pin === null) throw new Error("A draft-PR bundle needs the work order's pin")
    const delivery = DraftPrBundleDeliverySchema.parse(input.delivery)
    payload = {
      ...common,
      pin: input.pin,
      operation: "draft-pr",
      destinationId: draftPrDestinationId(delivery),
      delivery,
    }
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
