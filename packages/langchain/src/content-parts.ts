// packages/langchain/src/content-parts.ts
/**
 * AG-UI content parts → LangChain standard content blocks, under what the
 * route's model can take. Pure: the one place that decides a part is dropped,
 * so the capability document (once sub-project 3's PR 2 adds the `multimodal`
 * section) and the run agree.
 *
 * Spec (AG-UI 1.0, run-input): a producer handed a part it cannot use MUST NOT
 * fail the run; it skips the part, continues, and warns. The drops come back
 * as data for the caller to announce (`formatDroppedPartsWarning`, and the
 * `content_parts_dropped` chunk).
 */

import type {
  B4ContentPart,
  B4MessageContent,
  B4PartSource,
  BuiltInModelProviderId,
} from "@b4run/sdk"
import type { ModalitySupport } from "./chat-model-factory.js"

export type DropReason =
  | "modality_unsupported"
  | "url_source_unsupported"
  | "file_source_unsupported"
  | "foreign_file_provider"
  | "document_not_pdf"
  | "tool_result_media_unsupported"
  /**
   * The entry is not a structurally valid part; the AG-UI handler's schema parse
   * rejects these with a 400 before they get here, so this is reached only from
   * the Agent Protocol path or a direct caller.
   */
  | "malformed_part"

export interface DroppedPart {
  /** Position in the message's part list. */
  readonly index: number
  readonly type: string
  readonly source?: "data" | "url" | "file"
  readonly reason: DropReason
}

/** A LangChain standard content block (`@langchain/core` `Multimodal.Standard` or a text block). */
export type LangChainContentBlock = Readonly<Record<string, unknown>> & { readonly type: string }

/**
 * Hand block `content` to LangChain as `content:` together with
 * `response_metadata: V1_RESPONSE_METADATA`. `@langchain/core` recognises only
 * legacy `source_type` blocks unless the message is marked v1, and the v1 mark
 * is what makes the provider converters translate these blocks. Not
 * `contentBlocks:` — that form serializes without `kwargs.content`. A string
 * `content` needs no mark.
 */
export interface ConvertedContent {
  readonly content: string | readonly LangChainContentBlock[]
  readonly dropped: readonly DroppedPart[]
}

const PDF = "application/pdf"

/**
 * Providers whose converters accept only the legacy `image_url` block:
 * `@langchain/ollama` dist/utils.js (throws on anything but text/image_url and
 * decodes a base64 data URL) and `@langchain/mistralai` dist/chat_models.js
 * (accepts only text/image_url).
 */
const LEGACY_IMAGE_URL_PROVIDERS: ReadonlySet<BuiltInModelProviderId> = new Set([
  "ollama",
  "mistral",
])

function supportsModality(
  part: Extract<B4ContentPart, { type: "image" | "audio" | "video" | "document" }>,
  support: ModalitySupport,
): boolean {
  switch (part.type) {
    case "image":
      return support.image.data || support.image.url || support.file.image
    case "audio":
      return support.audio
    case "video":
      return support.video
    case "document":
      return support.pdf.data || support.pdf.url || support.file.pdf
  }
}

function toolResultAllows(type: string, support: ModalitySupport): boolean {
  if (type === "image") return support.toolResult.image
  if (type === "document") return support.toolResult.pdf
  return false
}

function block(
  type: "image" | "audio" | "video" | "file",
  source: B4PartSource,
): LangChainContentBlock {
  switch (source.type) {
    case "data":
      return { type, data: source.value, mimeType: source.mimeType }
    case "url":
      return {
        type,
        url: source.value,
        ...(source.mimeType !== undefined ? { mimeType: source.mimeType } : {}),
      }
    case "file":
      return {
        type,
        fileId: source.value,
        ...(source.mimeType !== undefined ? { mimeType: source.mimeType } : {}),
      }
  }
}

export function toLangChainContent(
  content: B4MessageContent,
  support: ModalitySupport,
  provider: BuiltInModelProviderId | undefined,
  position: "user" | "tool",
): ConvertedContent {
  if (typeof content === "string") return { content, dropped: [] }
  const blocks: LangChainContentBlock[] = []
  const dropped: DroppedPart[] = []
  for (const [index, part] of content.entries()) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text })
      continue
    }
    const drop = (reason: DropReason) =>
      dropped.push({ index, type: part.type, source: part.source.type, reason })

    if (part.type === "document" && part.source.mimeType !== PDF) {
      drop("document_not_pdf")
      continue
    }
    if (!supportsModality(part, support)) {
      drop("modality_unsupported")
      continue
    }
    if (position === "tool" && !toolResultAllows(part.type, support)) {
      drop("tool_result_media_unsupported")
      continue
    }
    if (part.source.type === "file") {
      const fileAllowed =
        part.type === "image"
          ? support.file.image
          : part.type === "document"
            ? support.file.pdf
            : false
      if (!fileAllowed) {
        drop("file_source_unsupported")
        continue
      }
      if (part.source.provider !== undefined && part.source.provider !== provider) {
        drop("foreign_file_provider")
        continue
      }
    } else if (part.type === "image") {
      // Image sources are gated individually: a model may take bytes but not a URL.
      if (part.source.type === "data" && !support.image.data) {
        drop("modality_unsupported")
        continue
      }
      if (part.source.type === "url" && (!support.image.url || provider === "ollama")) {
        // Ollama's converter decodes only base64 data URLs; a remote URL would be sent as "".
        drop("url_source_unsupported")
        continue
      }
    } else if (part.type === "document") {
      if (part.source.type === "data" && !support.pdf.data) {
        drop("modality_unsupported")
        continue
      }
      if (part.source.type === "url" && !support.pdf.url) {
        drop("url_source_unsupported")
        continue
      }
    }
    if (
      part.type === "image" &&
      provider !== undefined &&
      LEGACY_IMAGE_URL_PROVIDERS.has(provider)
    ) {
      const source = part.source
      const url =
        source.type === "data" ? `data:${source.mimeType};base64,${source.value}` : source.value
      blocks.push({ type: "image_url", image_url: { url } })
      continue
    }
    blocks.push(block(part.type === "document" ? "file" : part.type, part.source))
  }
  if (position === "tool" && blocks.every((b) => b.type === "text")) {
    // A text-only list carries nothing a string does not, and some converters
    // (ollama's tool message) reject non-string tool content.
    return { content: blocks.map((b) => String(b.text)).join(""), dropped }
  }
  return { content: blocks.length === 0 ? "" : blocks, dropped }
}

/**
 * Set on a message built with standard blocks under `content:`. The v1 mark is
 * what makes the provider converters translate standard blocks; `content:`
 * (not `contentBlocks:`) keeps `kwargs.content` in the serialized message.
 */
export const V1_RESPONSE_METADATA: Readonly<{ output_version: "v1" }> = Object.freeze({
  output_version: "v1",
})

export interface DroppedPartsReport {
  readonly provider?: string
  readonly model?: string
  readonly routeId?: string
  readonly messageId?: string
  readonly toolCallId?: string
  readonly parts: readonly DroppedPart[]
}

/**
 * The data of a `content_parts_dropped` announcement — the agent stream chunk
 * and the tool converter's `b4.capability` event share this one shape, so the
 * two cannot drift. Unknown provider/model are omitted, never `undefined`.
 */
export function droppedPartsData(
  modality:
    | { readonly provider?: string | undefined; readonly model?: string | undefined }
    | undefined,
  parts: readonly DroppedPart[],
  toolCallId?: string,
): Omit<DroppedPartsReport, "routeId"> {
  return {
    ...(modality?.provider !== undefined ? { provider: modality.provider } : {}),
    ...(modality?.model !== undefined ? { model: modality.model } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    parts,
  }
}

/** The spec's developer warning: what was dropped, why, and on which route. */
export function formatDroppedPartsWarning(report: DroppedPartsReport): string {
  const model = `${report.provider ?? "unknown"}/${report.model ?? "unknown"}`
  const list = report.parts
    .map((part) => `${part.type}/${part.source ?? "?"} (${part.reason})`)
    .join(", ")
  // Sub-project 3's PR 2 reintroduces a `GET /agui/:routeId` pointer once the `multimodal` section exists.
  const route = report.routeId !== undefined ? ` on route ${report.routeId}` : ""
  return `B4: dropped ${report.parts.length} content part(s) the model cannot use (${model})${route}: ${list}.`
}
