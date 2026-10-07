import {
  type B4ContentPart,
  type B4MediaPart,
  type B4MediaPartType,
  type B4PartSource,
  isContentPart,
  isContentPartArray,
} from "@b4run/sdk"

/**
 * LangChain content blocks back to AG-UI content parts: the reverse of
 * `toLangChainContent` in `packages/langchain/src/content-parts.ts`, for a
 * restored thread whose checkpoints hold the blocks the runtime wrote rather
 * than the parts the client sent.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const BLOCK_MEDIA_TYPES: Readonly<Record<string, B4MediaPartType>> = {
  audio: "audio",
  file: "document",
  image: "image",
  video: "video",
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s

function mimeTypeOf(block: Record<string, unknown>): string | undefined {
  const mimeType = block.mimeType ?? block.mime_type
  return typeof mimeType === "string" ? mimeType : undefined
}

/** A `data:` URL as an inline source, any other URL as a URL source. */
function urlSource(url: string, mimeType: string | undefined): B4PartSource {
  const inline = DATA_URL.exec(url)
  if (inline?.[1] !== undefined && inline[2] !== undefined)
    return { type: "data", value: inline[2], mimeType: inline[1] }
  return { type: "url", value: url, ...(mimeType !== undefined ? { mimeType } : {}) }
}

/** A v1 standard block's source: `data` (+ `mimeType`), `url`, or `fileId`. */
function blockSource(block: Record<string, unknown>): B4PartSource | undefined {
  const mimeType = mimeTypeOf(block)
  if (typeof block.data === "string") {
    // Inline bytes without their type cannot be drawn; skip them.
    return mimeType !== undefined ? { type: "data", value: block.data, mimeType } : undefined
  }
  if (typeof block.url === "string") return urlSource(block.url, mimeType)
  if (typeof block.fileId === "string")
    return { type: "file", value: block.fileId, ...(mimeType !== undefined ? { mimeType } : {}) }
  return undefined
}

/** The legacy `image_url` block ollama and mistral take: `{ url }` or a bare string. */
function legacyImageSource(block: Record<string, unknown>): B4PartSource | undefined {
  const raw = block.image_url
  const url = typeof raw === "string" ? raw : isRecord(raw) ? raw.url : undefined
  return typeof url === "string" ? urlSource(url, undefined) : undefined
}

/**
 * A checkpointed message's content as AG-UI content parts. A string is one
 * text part (none when empty). An array holds the blocks `toLangChainContent`
 * writes: `{type:"text",text}`, `{type:"image"|"audio"|"video"|"file",
 * data|url|fileId, mimeType}` (a PDF `document` is stored as `file`), and the
 * legacy `image_url` block for ollama/mistral; an entry that already is an
 * AG-UI part is kept. Anything else (a provider-specific block, a block
 * missing its source) is skipped rather than guessed at. Never throws.
 */
export function blocksToParts(content: unknown): B4ContentPart[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }]
  if (!Array.isArray(content)) return []
  const parts: B4ContentPart[] = []
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue
    if (block.type === "text") {
      if (typeof block.text === "string") parts.push({ type: "text", text: block.text })
      continue
    }
    if (isContentPart(block)) {
      parts.push(block)
      continue
    }
    if (block.type === "image_url") {
      const source = legacyImageSource(block)
      if (source !== undefined) parts.push({ type: "image", source })
      continue
    }
    const type = BLOCK_MEDIA_TYPES[block.type]
    if (type === undefined) continue
    const source = blockSource(block)
    if (source !== undefined) parts.push({ type, source })
  }
  return parts
}

/** The parts that are not text. */
export function mediaPartsOf(parts: readonly B4ContentPart[]): B4MediaPart[] {
  return parts.filter((part): part is B4MediaPart => part.type !== "text")
}

/**
 * The parts a ToolMessage kept for the UI (`additional_kwargs.b4_content_parts`,
 * `B4_CONTENT_PARTS_KEY` in `packages/langchain/src/tool-converter.ts`), or
 * undefined: the carrier the live translator's `keptParts` reads.
 */
export function keptToolParts(kwargs: Record<string, unknown>): B4ContentPart[] | undefined {
  const additional = kwargs.additional_kwargs
  const parts = isRecord(additional) ? additional.b4_content_parts : undefined
  return isContentPartArray(parts) && parts.length > 0 ? [...parts] : undefined
}
