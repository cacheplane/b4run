/**
 * Drives the Agent Protocol attach stream's body to completion, rendering
 * (or, in `json` mode, echoing) each frame and classifying how the stream
 * ended so the caller can map that onto a CLI exit code.
 */
import { parseStateFrame, projectTurnChunk } from "./attach-state.js"
import { createSseFrameParser, type SseFrame } from "./sse-frames.js"
import { renderFrame, renderSnapshot } from "./tail-render.js"

export type AttachOutcome = "done" | "detached" | "truncated"

export interface ConsumeAttachStreamResult {
  readonly outcome: AttachOutcome
  readonly reason?: string
  readonly retryMs?: number
}

export interface ConsumeAttachStreamOptions {
  readonly body: ReadableStream<Uint8Array>
  /** Write raw output text; the consumer supplies line separators. */
  readonly write: (text: string) => void
  readonly json?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readDetachReason(payload: unknown): string {
  if (isRecord(payload) && typeof payload.reason === "string") return payload.reason
  return "unknown"
}

/** Consume the attach stream's body until it ends, `done`, or `detached`. */
export async function consumeAttachStream(
  options: ConsumeAttachStreamOptions,
): Promise<ConsumeAttachStreamResult> {
  const { body, write, json = false } = options
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseFrameParser()

  let textOpen = false
  const endText = () => {
    if (textOpen) write("\n")
    textOpen = false
  }
  const line = (text: string) => {
    endText()
    write(`${text}\n`)
  }
  const token = (text: string) => {
    write(text)
    textOpen = true
  }

  let retryMs: number | undefined
  let outcome: AttachOutcome | undefined
  let reason: string | undefined

  const handleFrame = (frame: SseFrame): void => {
    if (frame.retry !== undefined) retryMs = frame.retry
    // Honor a trailing retry hint already received in this chunk, but never
    // render more events or replace the outcome after the terminal frame.
    if (outcome !== undefined) return

    if (json) {
      line(JSON.stringify(frame))
    } else if (frame.malformed) {
      line(`[malformed ${frame.event}] ${frame.raw ?? ""}`)
    } else if (frame.event === "state") {
      const state = parseStateFrame(frame.data)
      const lines = renderSnapshot(state)
      const lastChunk = state.turn?.at(-1)
      const continues =
        state.live &&
        !state.truncated &&
        state.interrupts.length === 0 &&
        lastChunk !== undefined &&
        projectTurnChunk(lastChunk).event === "chunk"
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index] ?? ""
        if (continues && index === lines.length - 1) token(text)
        else line(text)
      }
    } else if (frame.data !== undefined || frame.raw !== undefined) {
      for (const text of renderFrame(frame)) {
        if (frame.event === "chunk") token(text)
        else line(text)
      }
    }

    if (frame.event === "detached") {
      outcome = "detached"
      reason = readDetachReason(frame.data)
    } else if (frame.event === "done") {
      outcome = "done"
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const frames = parser.push(decoder.decode(value, { stream: true }))
      for (const frame of frames) handleFrame(frame)
      if (outcome !== undefined) break
    }
  } finally {
    // Also release the transport if the output sink fails. Cleanup cannot
    // replace a terminal outcome or the original read/write error.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    endText()
  }

  if (outcome === "detached") {
    return retryMs === undefined
      ? { outcome: "detached", reason: reason ?? "unknown" }
      : { outcome: "detached", reason: reason ?? "unknown", retryMs }
  }
  if (outcome === "done") {
    return retryMs === undefined ? { outcome: "done" } : { outcome: "done", retryMs }
  }
  return retryMs === undefined ? { outcome: "truncated" } : { outcome: "truncated", retryMs }
}
