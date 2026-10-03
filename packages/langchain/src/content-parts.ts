// packages/langchain/src/content-parts.ts
/**
 * AG-UI content parts → LangChain standard content blocks, under what the
 * route's model can take. Pure: the one place that decides a part is dropped,
 * so the capability document (`GET /agui/:routeId`) and the run agree.
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
 * Hand `content` to LangChain as `contentBlocks:` (`new HumanMessage({ contentBlocks })`,
 * `new ToolMessage({ contentBlocks, … })`), never `content:`. `@langchain/core`
 * recognises only legacy `source_type` blocks under `content:`; `contentBlocks:`
 * sets `response_metadata.output_version: "v1"`, which is what makes the OpenAI
 * converters translate these blocks. A string `content` may be passed either way.
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

export interface DroppedPartsReport {
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly routeId?: string
  readonly messageId?: string
  readonly toolCallId?: string
  readonly parts: readonly DroppedPart[]
}

/** The spec's developer warning: what was dropped, why, and where to see what is accepted. */
export function formatDroppedPartsWarning(report: DroppedPartsReport): string {
  const model = `${report.provider ?? "unknown"}/${report.model ?? "unknown"}`
  const list = report.parts
    .map((part) => `${part.type}/${part.source ?? "?"} (${part.reason})`)
    .join(", ")
  const pointer =
    report.routeId !== undefined
      ? ` GET /agui/${encodeURIComponent(report.routeId)} lists what this route accepts.`
      : ""
  return `B4: dropped ${report.parts.length} content part(s) the model cannot use (${model}): ${list}.${pointer}`
}
