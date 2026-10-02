import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { canon } from "../domain/digest.js"
import { relativePath, rootOrRelativePath } from "../domain/path.js"
import {
  BRANCH_PATTERN,
  COMMIT_PATTERN,
  DIGEST_PATTERN,
  FACTORY_BRANCH,
  REPOSITORY_PATTERN,
} from "../domain/work-order.js"
import { OBJECT_ID } from "./git-objects.js"

/**
 * The delivery outbox (rung 4 spec §5.1): what an approval of a draft-PR bundle authorized,
 * committed in the approval's own transaction, and how far the worker has got. One row per
 * work order. The intent never changes after it is written; `step` and `remote` advance
 * together, one compare-and-swap per step.
 */

export const OUTBOX_STEPS = [
  "pending",
  "checked",
  "committed",
  "branched",
  "opened",
  "confirmed",
] as const
export type OutboxStep = (typeof OUTBOX_STEPS)[number]

const ObjectId = z.string().regex(OBJECT_ID)

/** Everything the worker needs, frozen at approval: it never re-reads a mutable source. */
export const DeliveryIntentSchema = z
  .object({
    version: z.literal(1),
    workOrderId: z.string().min(1),
    bundleDigest: z.string().regex(DIGEST_PATTERN),
    candidateDigest: z.string().regex(DIGEST_PATTERN),
    /** The artifact holding the approved bytes; re-hashed on every read. */
    candidateArtifact: z.string().regex(DIGEST_PATTERN),
    repository: z.string().regex(REPOSITORY_PATTERN),
    baseBranch: z.string().regex(BRANCH_PATTERN),
    branch: z.string().regex(FACTORY_BRANCH),
    pin: z.string().regex(COMMIT_PATTERN),
    pathPrefix: rootOrRelativePath,
    issue: z
      .object({
        number: z.number().int().positive(),
        stateAtCreate: z.enum(["open", "closed"]),
      })
      .strict(),
    /** One entry per changed path, sorted by `path`. */
    paths: z
      .array(
        z
          .object({
            /** The repository path. */
            path: relativePath,
            /** The candidate's key: the path under the target's root. */
            workspacePath: relativePath,
            /** `git hash-object` of the baseline bytes the candidate was diffed against. */
            baselineBlob: ObjectId,
            /** `git hash-object` of the approved bytes. */
            candidateBlob: ObjectId,
          })
          .strict(),
      )
      .min(1),
    title: z.string().min(1).max(220),
    /** The approved `spec.md`, read with the task digest it was checked against. */
    specText: z.string(),
    approvedAt: z.string().min(1),
    decidedBy: z.string().min(1),
    digests: z
      .object({
        task: z.string().regex(DIGEST_PATTERN),
        policy: z.string().regex(DIGEST_PATTERN),
        environment: z.string().min(1),
        oracleReceiptId: z.string().min(1).nullable(),
        receiptId: z.string().min(1),
        reverificationReceiptId: z.string().min(1),
      })
      .strict(),
  })
  .strict()
export type DeliveryIntent = z.infer<typeof DeliveryIntentSchema>

/** What each step observed, filled as the steps advance. */
export const DeliveryRemoteSchema = z
  .object({
    check: z
      .object({
        baseTip: ObjectId,
        aheadBy: z.number().int().nonnegative(),
        pinTree: ObjectId,
        expectedTree: ObjectId,
        /** The pin's mode at each changed repository path, which the change keeps. */
        modes: z.record(z.string(), z.enum(["100644", "100755"])),
      })
      .strict()
      .optional(),
    commit: z.object({ sha: ObjectId }).strict().optional(),
    branch: z.object({ headSha: ObjectId }).strict().optional(),
    pull: z
      .object({ number: z.number().int().positive(), url: z.string().url(), nodeId: z.string() })
      .strict()
      .optional(),
  })
  .strict()
export type DeliveryRemote = z.infer<typeof DeliveryRemoteSchema>

export interface OutboxRow {
  readonly operationKey: string
  readonly workOrderId: string
  readonly bundleDigest: string
  readonly approvalId: string
  readonly intent: DeliveryIntent
  readonly step: OutboxStep
  readonly remote: DeliveryRemote
  readonly attempts: number
  readonly lastError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export class StaleOutboxStepError extends Error {
  constructor(
    readonly workOrderId: string,
    readonly expected: OutboxStep,
  ) {
    super(`Delivery outbox of ${workOrderId} is not at step ${expected}`)
    this.name = "StaleOutboxStepError"
  }
}

export interface OutboxStore {
  /**
   * Inside the approval's transaction. A second insert for one work order throws. The
   * operation key is derived (`deliveryOperationKey`), never the caller's.
   */
  insert(input: {
    readonly approvalId: string
    readonly intent: DeliveryIntent
    readonly now: string
  }): void
  get(workOrderId: string): OutboxRow | null
  /**
   * Compare-and-swap: from `from` to the step right after it, merging `remote`. Throws when
   * not at `from` (`StaleOutboxStepError`), when `to` is not the next step, or when `remote`
   * would overwrite something an earlier step observed.
   */
  advance(
    workOrderId: string,
    from: OutboxStep,
    to: OutboxStep,
    remote: DeliveryRemote,
    now: string,
  ): OutboxRow
  /** Count an attempt and keep its (scrubbed) error, or clear it with null. */
  note(workOrderId: string, lastError: string | null, now: string): void
}

/** The default operation key of a work order's delivery (spec §5.1). */
export const deliveryOperationKey = (workOrderId: string, bundleDigest: string) =>
  `deliver:${workOrderId}:${bundleDigest}`

export function createOutboxStore(db: DatabaseSync): OutboxStore {
  const get = (workOrderId: string): OutboxRow | null => {
    const r = db
      .prepare("SELECT * FROM delivery_outbox WHERE work_order_id = ?")
      .get(workOrderId) as Record<string, string | number | null> | undefined
    if (!r) return null
    return {
      operationKey: String(r.operation_key),
      workOrderId: String(r.work_order_id),
      bundleDigest: String(r.bundle_digest),
      approvalId: String(r.approval_id),
      intent: DeliveryIntentSchema.parse(JSON.parse(String(r.intent))),
      step: z.enum(OUTBOX_STEPS).parse(r.step),
      remote: DeliveryRemoteSchema.parse(JSON.parse(String(r.remote))),
      attempts: Number(r.attempts),
      lastError: r.last_error === null ? null : String(r.last_error),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  }
  return {
    insert({ approvalId, intent, now }) {
      const parsed = DeliveryIntentSchema.parse(intent)
      const operationKey = deliveryOperationKey(parsed.workOrderId, parsed.bundleDigest)
      db.prepare(
        "INSERT INTO delivery_outbox (operation_key, work_order_id, bundle_digest, approval_id, intent, step, remote, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', '{}', 0, NULL, ?, ?)",
      ).run(
        operationKey,
        parsed.workOrderId,
        parsed.bundleDigest,
        approvalId,
        canon(parsed),
        now,
        now,
      )
    },
    get,
    advance(workOrderId, from, to, remote, now) {
      if (OUTBOX_STEPS.indexOf(to) !== OUTBOX_STEPS.indexOf(from) + 1)
        throw new Error(
          `Delivery outbox steps advance one at a time: ${to} is not the next step after ${from}`,
        )
      const current = get(workOrderId)
      if (current === null || current.step !== from)
        throw new StaleOutboxStepError(workOrderId, from)
      const overwritten = (Object.keys(remote) as (keyof DeliveryRemote)[]).filter(
        (key) => remote[key] !== undefined && current.remote[key] !== undefined,
      )
      if (overwritten.length > 0)
        throw new Error(
          `Delivery outbox of ${workOrderId} already observed ${overwritten.join(", ")}; a step never overwrites an observation`,
        )
      const merged = DeliveryRemoteSchema.parse({ ...current.remote, ...remote })
      const result = db
        .prepare(
          "UPDATE delivery_outbox SET step = ?, remote = ?, updated_at = ? WHERE work_order_id = ? AND step = ?",
        )
        .run(to, canon(merged), now, workOrderId, from)
      if (result.changes !== 1) throw new StaleOutboxStepError(workOrderId, from)
      return get(workOrderId) as OutboxRow
    },
    note(workOrderId, lastError, now) {
      db.prepare(
        "UPDATE delivery_outbox SET attempts = attempts + ?, last_error = ?, updated_at = ? WHERE work_order_id = ?",
      ).run(lastError === null ? 0 : 1, lastError, now, workOrderId)
    },
  }
}
