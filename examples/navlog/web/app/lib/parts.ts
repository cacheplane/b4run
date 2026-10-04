import {
  type B4ContentPart,
  type B4MediaPart,
  type B4MediaPartType,
  type B4PartSource,
  isContentPart,
} from "@b4run/sdk"

/**
 * Content parts as the transcript renders them. Pure, no React: the shapes
 * here are AG-UI 1.0's `ContentPart` (`@b4run/sdk` declares them structurally
 * identical), and the two directions they arrive from are
 *
 * - the live stream, where a user or tool message's `content` is already
 *   `string | ContentPart[]` (`partsOf`), and
 * - a restored checkpoint, where LangChain stored its own standard blocks
 *   (`blocksToParts`), the reverse of `toLangChainContent` in
 *   `packages/langchain/src/content-parts.ts`.
 */

/** A message's content as a part list: a string is one text part, an array keeps its valid parts. */
export function partsOf(content: unknown): B4ContentPart[] {
  if (typeof content === "string")
    return content.length > 0 ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content.filter(isContentPart)
}

/** The parts that are not text — what a bubble or card has to draw beside its text. */
export function mediaParts(parts: readonly B4ContentPart[]): B4MediaPart[] {
  return parts.filter((part): part is B4MediaPart => part.type !== "text")
}

/**
 * Something an `<img src>` can load: inline bytes as a `data:` URL, a URL
 * source as itself. A provider file handle has no browser-loadable form, so it
 * is `undefined` and the caller shows the handle instead.
 */
export function dataUrl(part: B4MediaPart): string | undefined {
  const { source } = part
  if (source.type === "data") return `data:${source.mimeType};base64,${source.value}`
  if (source.type === "url") return source.value
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

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

/** A v1 standard block's source: `data` (+ `mimeType`), `url`, or `fileId`. */
function blockSource(block: Record<string, unknown>): B4PartSource | undefined {
  const mimeType = mimeTypeOf(block)
  const withMime = mimeType !== undefined ? { mimeType } : {}
  if (typeof block.data === "string") {
    // A data source without its type cannot become a loadable URL; skip it.
    return mimeType !== undefined ? { type: "data", value: block.data, mimeType } : undefined
  }
  if (typeof block.url === "string") {
    const inline = DATA_URL.exec(block.url)
    if (inline?.[1] !== undefined && inline[2] !== undefined)
      return { type: "data", value: inline[2], mimeType: inline[1] }
    return { type: "url", value: block.url, ...withMime }
  }
  if (typeof block.fileId === "string") return { type: "file", value: block.fileId, ...withMime }
  return undefined
}

/** The legacy `image_url` block ollama and mistral take: `{ url }` or a bare string. */
function legacyImageSource(block: Record<string, unknown>): B4PartSource | undefined {
  const raw = block.image_url
  const url = typeof raw === "string" ? raw : isRecord(raw) ? raw.url : undefined
  if (typeof url !== "string") return undefined
  const inline = DATA_URL.exec(url)
  if (inline?.[1] !== undefined && inline[2] !== undefined)
    return { type: "data", value: inline[2], mimeType: inline[1] }
  return { type: "url", value: url }
}

/**
 * A checkpointed message's LangChain content back to AG-UI parts. The blocks
 * are the ones `toLangChainContent` writes: `{type:"text",text}`,
 * `{type:"image"|"audio"|"video"|"file", data|url|fileId, mimeType}` (a PDF
 * `document` is stored as `file`), and the legacy `image_url` block for
 * ollama/mistral. Anything else (a provider-specific block, a block missing
 * its source) is skipped rather than guessed at.
 */
export function blocksToParts(content: unknown): B4ContentPart[] {
  if (typeof content === "string") return partsOf(content)
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
