import type { BaseMessage } from "@langchain/core/messages"

/**
 * Tokens charged per media block when counting history. A conservative
 * per-image estimate (a high-detail image is roughly 1k tokens on current
 * vision models); audio/video/files are charged the same flat amount. The
 * bytes themselves are never tokenized — base64 would count as tens of
 * thousands of text tokens and trigger summarization on a single image.
 */
export const MEDIA_TOKEN_ESTIMATE = 1_000

const PLACEHOLDER_TYPES: ReadonlySet<string> = new Set(["image", "audio", "video", "file"])

export interface MessageText {
  /** Text blocks concatenated; each media block rendered as `[image]`/`[audio]`/`[video]`/`[file]`/`[media]`. */
  readonly text: string
  /** Number of non-text blocks rendered as placeholders. */
  readonly mediaCount: number
}

/**
 * A message's content as text for summarization: a string is returned as is;
 * a block list keeps its text blocks and renders every other block as a
 * placeholder, so neither the token counter nor the summarizer prompt ever
 * sees base64.
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
    mediaCount += 1
    const type = typeof record.type === "string" ? record.type : ""
    text += PLACEHOLDER_TYPES.has(type) ? `[${type}]` : "[media]"
  }
  return { text, mediaCount }
}
