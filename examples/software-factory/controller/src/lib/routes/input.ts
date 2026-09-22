import { z } from "zod"
import { COMMIT_PATTERN, DIGEST_PATTERN, IssueOriginSchema } from "../domain/work-order.js"

export const CatalogCreateInput = z
  .object({ taskId: z.string().min(1), operationKey: z.string().min(1).optional() })
  .strict()
export const IssueCreateInput = z
  .object({
    origin: IssueOriginSchema,
    pin: z.string().regex(COMMIT_PATTERN),
    issue: z.object({ title: z.string().min(1), body: z.string() }).strict(),
    operationKey: z.string().min(1).optional(),
  })
  .strict()
export type CatalogCreate = z.infer<typeof CatalogCreateInput>
export type IssueCreate = z.infer<typeof IssueCreateInput>
/** One or the other, never both: each half is strict, so a mixed input fails both. */
export type CreateInput = CatalogCreate | IssueCreate
/**
 * The half of `CreateInput` an input is addressed to, chosen by the presence of `taskId`, so a
 * partly-right issue payload is reported with flat, addressed issues (`pin: ...`) rather than
 * the buried tree a union failure would produce for both halves.
 */
export function createInputSchema(input: unknown): z.ZodType<CreateInput> {
  const catalog = typeof input === "object" && input !== null && "taskId" in input
  return catalog ? CatalogCreateInput : IssueCreateInput
}
export const IdInput = z
  .object({ id: z.string().min(1), operationKey: z.string().min(1).optional() })
  .strict()
export const ApproveInput = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    bundleDigest: z.string().regex(DIGEST_PATTERN),
    operationKey: z.string().min(1).optional(),
  })
  .strict()
/** The intake gate's approval: the revision read and the digest of the directory read. */
export const ApproveIntakeInput = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    taskDigest: z.string().regex(DIGEST_PATTERN),
    operationKey: z.string().min(1).optional(),
  })
  .strict()
/** The intake gate's rejection: a note is required, because the next drafter turn quotes it. */
export const RejectIntakeInput = z
  .object({
    id: z.string().min(1),
    note: z.string().min(1),
    operationKey: z.string().min(1).optional(),
  })
  .strict()
export const ReconcileInput = z.object({}).strict()
