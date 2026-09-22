import { z } from "zod"
import { DIGEST_PATTERN } from "../domain/work-order.js"

export const CreateInput = z
  .object({ taskId: z.string().min(1), operationKey: z.string().min(1).optional() })
  .strict()
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
