import { z } from "zod"

/** One Server-Sent Event as the runtime emits it: `event:` name and parsed `data:`. */
export interface StreamFrame {
  readonly event: string
  readonly data: unknown
}

export const InterruptFrameSchema = z.looseObject({
  interruptId: z.string().min(1),
  type: z.literal("permission-request"),
  kind: z.string().min(1),
  detail: z.record(z.string(), z.unknown()),
})
export type InterruptFrame = z.infer<typeof InterruptFrameSchema>

export const ToolResultFrameSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().min(1),
  output: z.unknown(),
})

export const DoneFrameSchema = z.looseObject({ output: z.unknown() })

export const ThreadSchema = z.looseObject({ thread_id: z.string().min(1), status: z.string() })

/** `PUT /workspace/sources/:digest`'s answer: `created` for new bytes, `held` for bytes it had. */
export const StagedSourceResponseSchema = z
  .object({ digest: z.string().regex(/^[0-9a-f]{64}$/), status: z.enum(["created", "held"]) })
  .strict()

export const PendingInterruptsSchema = z.object({ interrupts: z.array(InterruptFrameSchema) })

export const CancelResponseSchema = z.object({
  thread_id: z.string().min(1),
  status: z.literal("interrupted"),
})

export const ErrorBodySchema = z.looseObject({
  error: z.looseObject({
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

/** Read `output.error` / `output.cancelled` from a `done` frame without trusting its shape. */
export function classifyDone(data: unknown): { error: string | null; cancelled: boolean } {
  const parsed = DoneFrameSchema.safeParse(data)
  if (!parsed.success || typeof parsed.data.output !== "object" || parsed.data.output === null)
    return { error: null, cancelled: false }
  const output = parsed.data.output as Record<string, unknown>
  return {
    error: typeof output.error === "string" ? output.error : null,
    cancelled: output.cancelled === true,
  }
}
