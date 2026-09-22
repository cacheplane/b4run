import { z } from "zod"
import { BLOCKED_REASONS, FAILURE_REASONS, STATES } from "./states.js"

export const DIGEST_PATTERN = /^[a-f0-9]{64}$/
/** A GitHub `owner/name`, as `gh --repo` takes it. */
export const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/

/**
 * Where a work order came from. A catalog work order names one of the controller's own tasks;
 * an issue work order was drafted from a GitHub issue, and `bodyDigest` is the digest of the
 * issue body the draft was made from, so a later edit to the issue is detectable.
 */
export const CatalogOriginSchema = z.object({ kind: z.literal("catalog") }).strict()
export const IssueOriginSchema = z
  .object({
    kind: z.literal("issue"),
    repository: z.string().regex(REPOSITORY_PATTERN),
    number: z.number().int().positive(),
    bodyDigest: z.string().regex(DIGEST_PATTERN),
  })
  .strict()
export const OriginSchema = z.discriminatedUnion("kind", [CatalogOriginSchema, IssueOriginSchema])
export type Origin = z.infer<typeof OriginSchema>
export type IssueOrigin = z.infer<typeof IssueOriginSchema>

export const WorkOrderRowSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  state: z.enum(STATES),
  taskId: z.string().min(1),
  workerRoute: z.string().min(1),
  workerThreadId: z.string().min(1).nullable(),
  /** Set only when an unexpected interrupt is found parked on the thread; rung 1 has no gate. */
  interruptId: z.string().min(1).nullable(),
  candidateDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  /** Set when the controller freezes a review bundle; what approval binds to. */
  bundleDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  blockedReason: z.enum(BLOCKED_REASONS).nullable(),
  failureReason: z.enum(FAILURE_REASONS).nullable(),
  maxCandidateAttempts: z.number().int().positive(),
  maxActiveMs: z.number().int().positive(),
  activeMs: z.number().int().nonnegative(),
  activeStartedAt: z.string().nullable(),
  /** When the work order entered awaiting_approval; approval expiry is measured from here. */
  awaitingSince: z.string().nullable(),
  origin: OriginSchema,
  /**
   * The target repository commit the work order was created against; null for a catalog work
   * order, recorded by `create --issue` and never changed.
   */
  pin: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  /** The prepared target the drafted task fits; null until intake resolves it. */
  targetId: z.string().min(1).nullable(),
  /** The digest of the generated task directory the intake gate binds to. */
  taskDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  /** Drafter turns spent so far; a retry or a rejection spends one. */
  intakeAttempts: z.number().int().nonnegative(),
  maxIntakeAttempts: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type WorkOrderRow = z.infer<typeof WorkOrderRowSchema>

export const FactoryEventSchema = z.object({
  seq: z.number().int(),
  workOrderId: z.string(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  at: z.string(),
})
export type FactoryEvent = z.infer<typeof FactoryEventSchema>

export const COMMANDS = [
  "create",
  "intake",
  "approve_intake",
  "reject_intake",
  "dispatch",
  "approve",
  "deny",
  "cancel",
] as const
export type CommandName = (typeof COMMANDS)[number]

export const CommandIntentSchema = z.object({
  command: z.enum(COMMANDS),
  args: z.record(z.string(), z.unknown()),
})
export type CommandIntent = z.infer<typeof CommandIntentSchema>

export const CommandOutcomeSchema = z.object({
  ok: z.boolean(),
  state: z.enum(STATES).optional(),
  message: z.string().min(1),
})
export type CommandOutcome = z.infer<typeof CommandOutcomeSchema>

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  workOrderId: z.string().min(1),
  bundleDigest: z.string().regex(DIGEST_PATTERN),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  decision: z.enum(["approved", "denied"]),
  decidedBy: z.string().min(1),
  decidedAt: z.string(),
  expiresAt: z.string(),
})
export type Approval = z.infer<typeof ApprovalSchema>

export const DeliverySchema = z.object({
  workOrderId: z.string().min(1),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  receiptPath: z.string().min(1),
  observedAt: z.string(),
})
export type Delivery = z.infer<typeof DeliverySchema>

export const VERDICTS = ["pass", "fail", "inconclusive"] as const
export type Verdict = (typeof VERDICTS)[number]

export const CandidateSchema = z.object({
  digest: z.string().regex(DIGEST_PATTERN),
  workOrderId: z.string().min(1),
  baselineDigest: z.string().regex(DIGEST_PATTERN),
  changedPaths: z.array(z.string().min(1)).min(1),
  bytes: z.number().int().nonnegative(),
  artifactDigest: z.string().regex(DIGEST_PATTERN),
  assembledAt: z.string(),
})
export type Candidate = z.infer<typeof CandidateSchema>

export const CheckResultSchema = z.object({
  id: z.string().min(1),
  acceptanceIds: z.array(z.string().min(1)),
  verdict: z.enum(VERDICTS),
  evidence: z.array(z.object({ id: z.string().min(1), digest: z.string().regex(DIGEST_PATTERN) })),
})

export const ReceiptSchema = z.object({
  id: z.string().min(1),
  workOrderId: z.string().min(1),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  /** Assigned by the harness that ran the checks, never by a worker. */
  verifierIdentity: z.string().min(1),
  policyDigest: z.string().regex(DIGEST_PATTERN),
  environmentIdentity: z.string().min(1),
  verdict: z.enum(VERDICTS),
  checks: z.array(CheckResultSchema),
  issuedAt: z.string(),
})
export type Receipt = z.infer<typeof ReceiptSchema>

export const BundleSchema = z.object({
  digest: z.string().regex(DIGEST_PATTERN),
  workOrderId: z.string().min(1),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  receiptId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  frozenAt: z.string(),
})
export type Bundle = z.infer<typeof BundleSchema>
