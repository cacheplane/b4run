import type { BaseMessage } from "@langchain/core/messages"

/**
 * Tokens charged per media block when counting history. A conservative
 * per-image estimate (a high-detail image is roughly 1k tokens on current
 * vision models); audio/video/files are charged the same flat amount. The
 * bytes themselves are never tokenized — base64 would count as tens of
 * thousands of text tokens and trigger summarization on a single image.
 */
export const MEDIA_TOKEN_ESTIMATE = 1_000

/**
 * The block types that carry media bytes or a media reference. Only these are
 * rendered as placeholders and charged `MEDIA_TOKEN_ESTIMATE`; any other
 * non-text block (`tool_use`, `thinking`, `reasoning`, …) keeps its JSON text.
 */
const MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image",
  "audio",
  "video",
  "file",
  "document",
  "image_url",
])

export interface MessageText {
  /**
   * Text blocks concatenated; each media block rendered as `[image]`/`[audio]`/
   * `[video]`/`[file]`/`[document]` (legacy `image_url` as `[image]`); any other
   * block JSON-stringified.
   */
  readonly text: string
  /** Number of media blocks rendered as placeholders. */
  readonly mediaCount: number
}

/**
 * A message's content as text for summarization: a string is returned as is;
 * a block list keeps its text blocks, renders each media block as a
 * placeholder — so neither the token counter nor the summarizer prompt ever
 * sees base64 — and JSON-stringifies every other block (tool use, reasoning).
 */
export function messageContentText(content: BaseMessage["content"]): MessageText {
  if (typeof content === "string") return { text: content, mediaCount: 0 }
  if (!Array.isArray(content)) return { text: "", mediaCount: 0 }
  let text = ""
  let mediaCount = 0
  for (const block of content as readonly unknown[]) {
    if (typeof block === "string") {
      text += block
      continue
    }
    const record = (typeof block === "object" && block !== null ? block : {}) as Record<
      string,
      unknown
    >
    if (record.type === "text") {
      text += typeof record.text === "string" ? record.text : ""
      continue
    }
    const type = typeof record.type === "string" ? record.type : ""
    if (MEDIA_TYPES.has(type)) {
      mediaCount += 1
      text += `[${type === "image_url" ? "image" : type}]`
      continue
    }
    text += JSON.stringify(block) ?? ""
  }
  return { text, mediaCount }
}
