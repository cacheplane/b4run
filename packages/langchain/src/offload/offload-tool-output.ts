import type { OffloadStore } from "./offload-store.js"
import { buildPreview, buildStub } from "./stub.js"

/**
 * Characters of an oversized output kept when offloading it FAILED. The stub
 * then carries this much preview and nothing else, so a broken spill path can
 * never put the full output into the model context.
 */
export const OFFLOAD_FAILURE_PREVIEW_CHARS = 8192

const MAX_ERROR_MESSAGE_CHARS = 200

export interface OffloadToolOutputCtx {
  readonly toolName: string
  readonly thresholdChars: number
  readonly previewLines: number
  readonly store: Pick<OffloadStore, "write">
  readonly signal?: AbortSignal
  readonly toolCallId?: string
  /**
   * Told when the offload write fails, with the sanitized error message (the
   * same text the stub carries). The caller decides how to surface it.
   */
  readonly onError?: (message: string) => void
}

/**
 * The error's message with absolute paths elided: a failed write's message can
 * name a host path outside the workspace, which the model must not see.
 */
export function sanitizeOffloadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`,;:()]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
  const text = message.length > 0 ? message : "unknown error"
  return text.length > MAX_ERROR_MESSAGE_CHARS ? `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}…` : text
}

function buildFailureStub(content: string, ctx: OffloadToolOutputCtx, message: string): string {
  const preview = buildPreview(content, ctx.previewLines, OFFLOAD_FAILURE_PREVIEW_CHARS)
  const chars = content.length.toLocaleString("en-US")
  const threshold = ctx.thresholdChars.toLocaleString("en-US")
  return [
    `[Tool output too large — ${chars} chars exceeded the ${threshold}-char limit and could not be offloaded to the workspace.`,
    `Offloading failed: ${message}`,
    `The output was truncated to ${OFFLOAD_FAILURE_PREVIEW_CHARS.toLocaleString("en-US")} chars and the rest was discarded; it is not saved anywhere.`,
    `Preview (first ${preview.lines} lines):`,
    preview.text,
    `Re-run with a narrower command or query to see more.]`,
  ].join("\n")
}

export async function offloadToolOutput(
  content: string,
  ctx: OffloadToolOutputCtx,
): Promise<string> {
  if (content.length <= ctx.thresholdChars) return content
  let relPath: string
  try {
    relPath = await ctx.store.write(ctx.toolName, content, ctx.toolCallId, ctx.signal)
  } catch (error) {
    // Never break a tool because offloading failed — but never inline the
    // oversized output either: that is exactly what the threshold guards
    // against. Fail closed to a bounded preview.
    const message = sanitizeOffloadError(error)
    ctx.onError?.(message)
    return buildFailureStub(content, ctx, message)
  }
  return buildStub({
    content,
    relPath,
    previewLines: ctx.previewLines,
    thresholdChars: ctx.thresholdChars,
  })
}
