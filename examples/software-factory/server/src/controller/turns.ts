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
  readonly ended: "done" | "lost" | "handler_error"
  readonly interrupts: InterruptFrame[]
  readonly error?: string
  readonly malformed?: number
}

/**
 * Drive one Server-Sent Events turn to its end. Transport errors and a stream that
 * ends without done surface as `ended: "lost"`; a throwing handler surfaces as
 * `ended: "handler_error"`; nothing propagates.
 */
export async function consumeTurn(
  frames: AsyncIterable<StreamFrame>,
  handlers: TurnHandlers,
): Promise<TurnResult> {
  const interrupts: InterruptFrame[] = []
  let malformed = 0
  let first = true
  let sawDone = false
  let phase: "transport" | "handler" = "transport"
  try {
    for await (const frame of frames) {
      phase = "transport"
      if (first) {
        first = false
        phase = "handler"
        await handlers.onFirstFrame?.()
        phase = "transport"
      }
      if (frame.event === "tool_result") {
        const parsed = ToolResultFrameSchema.safeParse(frame.data)
        if (!parsed.success) {
          malformed += 1
          continue
        }
        phase = "handler"
        await handlers.onToolResult?.(parsed.data.name, parsed.data.output)
        phase = "transport"
      } else if (frame.event === "interrupt") {
        const parsed = InterruptFrameSchema.safeParse(frame.data)
        if (!parsed.success) {
          malformed += 1
          continue
        }
        interrupts.push(parsed.data)
        phase = "handler"
        await handlers.onInterrupt?.(parsed.data)
        phase = "transport"
      } else if (frame.event === "done") {
        sawDone = true
        phase = "handler"
        await handlers.onDone?.(frame.data)
        phase = "transport"
      }
    }
  } catch (error) {
    if (phase === "handler")
      return {
        ended: "handler_error",
        interrupts,
        error: String(error),
        ...(malformed ? { malformed } : {}),
      }
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
