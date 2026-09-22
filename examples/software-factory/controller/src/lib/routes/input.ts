import { z } from "zod"
import { DIGEST_PATTERN, IssueOriginSchema } from "../domain/work-order.js"

export const CatalogCreateInput = z
  .object({ taskId: z.string().min(1), operationKey: z.string().min(1).optional() })
  .strict()
export const IssueCreateInput = z
  .object({
    origin: IssueOriginSchema,
    pin: z.string().regex(/^[a-f0-9]{40}$/),
    issue: z.object({ title: z.string().min(1), body: z.string() }).strict(),
    operationKey: z.string().min(1).optional(),
  })
  .strict()
/** One or the other, never both: each half is strict, so a mixed input fails both. */
export const CreateInput = z.union([CatalogCreateInput, IssueCreateInput])
export type CatalogCreate = z.infer<typeof CatalogCreateInput>
export type IssueCreate = z.infer<typeof IssueCreateInput>
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
export const ReconcileInput = z.object({}).strict()
