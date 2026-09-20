import type { MiddlewareAfterHook, MiddlewareAfterRun, RejectResult } from "@b4run/sdk"
import type { StreamChunk } from "../runtime/stream-types.js"

/**
 * The error a middleware `after` rejection becomes. Thrown into the run
 * stream, so the AG-UI translator ends the run with a `RUN_ERROR` carrying
 * `message` and `code` — the same path an upstream failure takes, so nothing
 * downstream needs a new branch.
 */
export class MiddlewareAfterError extends Error {
  readonly code = "middleware_rejected"
  readonly status: number
  readonly body: unknown

  constructor(result: RejectResult) {
    super(rejectMessage(result.body))
    this.name = "MiddlewareAfterError"
    this.status = result.status
    this.body = result.body
  }
}

const DEFAULT_REJECT_MESSAGE = "The final assistant message was rejected by middleware"

function rejectMessage(body: unknown): string {
  if (typeof body === "string" && body.length > 0) return body
  if (body && typeof body === "object") {
    const record = body as { readonly message?: unknown; readonly error?: unknown }
    if (typeof record.message === "string" && record.message.length > 0) return record.message
    if (typeof record.error === "string" && record.error.length > 0) return record.error
  }
  return DEFAULT_REJECT_MESSAGE
}

type TextChunk = Extract<StreamChunk, { readonly type: "chunk" }>

function isTextChunk(chunk: StreamChunk): chunk is TextChunk {
  return chunk.type === "chunk" && typeof (chunk as { readonly data?: unknown }).data === "string"
}

function messageEndId(chunk: StreamChunk): string | undefined {
  if (chunk.type !== "message_end") return undefined
  const data = (chunk as { readonly data?: unknown }).data
  return data &&
    typeof data === "object" &&
    typeof (data as { messageId?: unknown }).messageId === "string"
    ? (data as { messageId: string }).messageId
    : undefined
}

/**
 * Apply a middleware `after` hook to a route's chunk stream.
 *
 * The final assistant message is only known once the run is over, and the
 * runtime streams it token by token — so with a hook defined, the text of the
 * message that MIGHT be final is held back until the stream settles. What
 * proves a message was not final is released at once: a tool call, a tool
 * result, or the first token of a later model message. Everything that is not
 * assistant text (tool frames, capability chunks) passes through immediately,
 * which means it can reach the client ahead of text the model produced
 * before it. Without a hook the handler does not wrap the stream at all.
 *
 * On `done` (or on a stream that ends without one) the hook runs with the
 * buffered text. Nothing → the buffer is released as is. `{ finalMessage }` →
 * one replacement token under the same model message identity (empty means
 * no message). `reject(...)` → a {@link MiddlewareAfterError} is thrown before
 * `done`, so the run ends with `RUN_ERROR` and the client never sees the
 * rejected text. A parked turn (an `interrupt` chunk) skips the hook: its
 * final message belongs to the resume that completes it.
 */
export async function* applyMiddlewareAfter(
  chunks: AsyncIterable<StreamChunk>,
  hook: MiddlewareAfterHook,
  run: Omit<MiddlewareAfterRun, "finalMessage">,
): AsyncGenerator<StreamChunk> {
  /** The model message currently held back: its text, and its trailing end marker if seen. */
  let held: {
    messageId: string | undefined
    text: string
    chunks: StreamChunk[]
    ended: StreamChunk | undefined
  } | null = null
  let parked = false

  const release = (): StreamChunk[] => {
    if (!held) return []
    const out = held.ended ? [...held.chunks, held.ended] : held.chunks
    held = null
    return out
  }

  const settle = async function* (done: StreamChunk | undefined): AsyncGenerator<StreamChunk> {
    if (parked) {
      yield* release()
      if (done) yield done
      return
    }
    const finalMessage = held?.text ?? ""
    const result = await hook({ ...run, finalMessage })
    if (result && "action" in result && result.action === "reject") {
      throw new MiddlewareAfterError(result)
    }
    if (result && "finalMessage" in result && typeof result.finalMessage === "string") {
      const messageId = held?.messageId
      const ended = held?.ended
      held = null
      if (result.finalMessage.length > 0) {
        yield { type: "chunk", data: result.finalMessage, ...(messageId ? { messageId } : {}) }
        if (ended) yield ended
      }
    } else {
      yield* release()
    }
    if (done) yield done
  }

  for await (const chunk of chunks) {
    if (chunk.type === "done") {
      yield* settle(chunk)
      return
    }
    if (isTextChunk(chunk)) {
      const messageId = chunk.messageId
      if (held && (held.ended || held.messageId !== messageId)) {
        // A later model message means the held one was not final.
        yield* release()
      }
      held ??= { chunks: [], ended: undefined, messageId, text: "" }
      held.chunks.push(chunk)
      held.text += chunk.data as string
      continue
    }
    const endedId = messageEndId(chunk)
    if (endedId !== undefined) {
      if (held && held.messageId === endedId && !held.ended) {
        held.ended = chunk
      } else {
        yield chunk
      }
      continue
    }
    if (chunk.type === "tool_call" || chunk.type === "tool_result") {
      // The model is not done: whatever it said before this streams live.
      yield* release()
      yield chunk
      continue
    }
    if (chunk.type === "interrupt") {
      parked = true
      yield* release()
      yield chunk
      continue
    }
    yield chunk
  }
  yield* settle(undefined)
}
