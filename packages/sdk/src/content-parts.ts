// packages/sdk/src/content-parts.ts
/**
 * Message content parts, structurally identical to AG-UI 1.0's `ContentPart`
 * (`@ag-ui/core`), declared here so tools, middleware and the langchain
 * adapter never import the protocol package. `packages/ag-ui` pins the two
 * shapes to each other at compile time.
 *
 * A media part's `source` says where its bytes are: carried inline (`data`),
 * fetchable by URL (`url`) — B4.run never fetches it; the provider does — or
 * already at the model provider under a handle it issued (`file`).
 */

export interface B4DataSource {
  readonly type: "data"
  /** The bytes, base64-encoded. */
  readonly value: string
  readonly mimeType: string
}

export interface B4UrlSource {
  readonly type: "url"
  readonly value: string
  readonly mimeType?: string
}

export interface B4FileSource {
  readonly type: "file"
  /** The provider's handle, opaque: never fetched, parsed or inspected. */
  readonly value: string
  /** Lowercase vendor id (`openai`, `anthropic`, `google`) when the producer knows it. */
  readonly provider?: string
  readonly mimeType?: string
}

export type B4PartSource = B4DataSource | B4UrlSource | B4FileSource

export interface B4TextPart {
  readonly type: "text"
  readonly text: string
  readonly id?: string
  /** Any non-null value; the protocol rejects `null`. */
  readonly metadata?: unknown
}

export type B4MediaPartType = "image" | "audio" | "video" | "document"

export interface B4MediaPart {
  readonly type: B4MediaPartType
  readonly source: B4PartSource
  readonly id?: string
  /** Any non-null value; the protocol rejects `null`. */
  readonly metadata?: unknown
}

export type B4ContentPart = B4TextPart | B4MediaPart

/**
 * What a user or tool message carries: plain text, or an ordered list of parts.
 * A consumer handing parts to the protocol or to LangChain should copy the
 * readonly array (`[...parts]`) rather than cast it.
 */
export type B4MessageContent = string | readonly B4ContentPart[]

const MEDIA_PART_TYPES: ReadonlySet<string> = new Set(["image", "audio", "video", "document"])
const SOURCE_TYPES: ReadonlySet<string> = new Set(["data", "url", "file"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPartSource(value: unknown): value is B4PartSource {
  if (!isRecord(value) || typeof value.type !== "string" || !SOURCE_TYPES.has(value.type))
    return false
  if (typeof value.value !== "string") return false
  if (value.type === "data") return typeof value.mimeType === "string"
  if (value.mimeType !== undefined && typeof value.mimeType !== "string") return false
  if (value.type === "file" && value.provider !== undefined && typeof value.provider !== "string")
    return false
  return true
}

export function isContentPart(value: unknown): value is B4ContentPart {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.id !== undefined && typeof value.id !== "string") return false
  if (value.metadata === null) return false
  if (value.type === "text") return typeof value.text === "string"
  return MEDIA_PART_TYPES.has(value.type) && isPartSource(value.source)
}

/** Structural guard for an unvalidated content array; an empty array is a (text-less) part list. */
export function isContentPartArray(value: unknown): value is readonly B4ContentPart[] {
  return Array.isArray(value) && value.every(isContentPart)
}

/** The text of a message: a string as is; a part list's text parts, in order; media contributes nothing. */
export function contentPartsText(content: B4MessageContent): string {
  if (typeof content === "string") return content
  let text = ""
  for (const part of content) if (part.type === "text") text += part.text
  return text
}
