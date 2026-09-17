import {
  type InterruptFrame,
  InterruptFrameSchema,
  type StreamFrame,
  ToolResultFrameSchema,
} from "../worker/wire.js"

export interface TurnHandlers {
  onFirstFrame?: () => Promise<void>
  onToolResult?: (name: string, output: unknown) => Promise<void>
  onInterrupt?: (frame: InterruptFrame) => Promise<void>
  onDone?: (data: unknown) => Promise<void>
}

export interface TurnResult {
  readonly ended: "done" | "lost"
  readonly interrupts: InterruptFrame[]
  readonly error?: string
  readonly malformed?: number
}

/**
 * Drive one Server-Sent Events turn to its end. Both handler errors and transport
 * errors surface as `ended: "lost"` (with `error` set) so the caller can reconcile
 * instead of guessing; nothing thrown here propagates to the caller.
 */
export async function consumeTurn(
  frames: AsyncIterable<StreamFrame>,
  handlers: TurnHandlers,
): Promise<TurnResult> {
  const interrupts: InterruptFrame[] = []
  let malformed = 0
  let first = true
  let sawDone = false
  try {
    for await (const frame of frames) {
      if (first) {
        first = false
        await handlers.onFirstFrame?.()
      }
      if (frame.event === "tool_result") {
        const parsed = ToolResultFrameSchema.safeParse(frame.data)
        if (!parsed.success) {
          malformed += 1
          continue
        }
        await handlers.onToolResult?.(parsed.data.name, parsed.data.output)
      } else if (frame.event === "interrupt") {
        const parsed = InterruptFrameSchema.safeParse(frame.data)
        if (!parsed.success) {
          malformed += 1
          continue
        }
        interrupts.push(parsed.data)
        await handlers.onInterrupt?.(parsed.data)
      } else if (frame.event === "done") {
        sawDone = true
        await handlers.onDone?.(frame.data)
      }
    }
  } catch (error) {
    return { ended: "lost", interrupts, error: String(error), ...(malformed ? { malformed } : {}) }
  }
  if (!sawDone)
    return {
      ended: "lost",
      interrupts,
      error: "stream ended without a done frame",
      ...(malformed ? { malformed } : {}),
    }
  return { ended: "done", interrupts, ...(malformed ? { malformed } : {}) }
}
