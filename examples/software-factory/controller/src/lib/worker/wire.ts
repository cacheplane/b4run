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

/**
 * One finished model call, as the runtime forwards the provider's own `usage_metadata`
 * (`event: usage`). Only the counts the ledger sums are read; the rest passes untouched.
 */
export const UsageFrameSchema = z.looseObject({
  provider: z.string().optional(),
  model: z.string().optional(),
  usage_metadata: z.looseObject({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    total_tokens: z.number().nonnegative().optional(),
    input_token_details: z
      .looseObject({ cache_read: z.number().nonnegative().optional() })
      .optional(),
    output_token_details: z
      .looseObject({ reasoning: z.number().nonnegative().optional() })
      .optional(),
  }),
})
export type UsageFrame = z.infer<typeof UsageFrameSchema>

/** The journal's `model_usage` payload, flattened from a usage frame: one line per model call. */
export function modelUsagePayload(frame: UsageFrame): Record<string, unknown> {
  const usage = frame.usage_metadata
  return {
    ...(frame.provider !== undefined ? { provider: frame.provider } : {}),
    ...(frame.model !== undefined ? { model: frame.model } : {}),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.input_token_details?.cache_read ?? 0,
    reasoningTokens: usage.output_token_details?.reasoning ?? 0,
    totalTokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
  }
}

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
