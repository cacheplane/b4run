// packages/langchain/test/content-parts.test.ts
import type { B4ContentPart } from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import { DEFAULT_MODALITY_SUPPORT, type ModalitySupport } from "../src/chat-model-factory.ts"
import { formatDroppedPartsWarning, toLangChainContent } from "../src/content-parts.ts"

const ALL: ModalitySupport = {
  image: { data: true, url: true },
  pdf: true,
  audio: true,
  video: true,
  toolResult: { image: true, pdf: true },
  file: { image: true, pdf: true },
}

const png = {
  type: "image",
  source: { type: "data", value: "AAAA", mimeType: "image/png" },
} as const
const imgUrl = { type: "image", source: { type: "url", value: "https://x.test/a.png" } } as const
const pdf = {
  type: "document",
  source: { type: "data", value: "JVBERi0=", mimeType: "application/pdf" },
} as const
const wav = {
  type: "audio",
  source: { type: "data", value: "UklGRg==", mimeType: "audio/wav" },
} as const
const mp4 = { type: "video", source: { type: "url", value: "https://x.test/a.mp4" } } as const
const handle = {
  type: "image",
  source: { type: "file", value: "file_abc", provider: "openai" },
} as const

describe("toLangChainContent — user position", () => {
  it("returns a string unchanged with no drops", () => {
    expect(toLangChainContent("hi", ALL, "openai", "user")).toEqual({ content: "hi", dropped: [] })
  })

  it("maps every part and source to LangChain standard blocks when supported", () => {
    const parts: B4ContentPart[] = [
      { type: "text", text: "look" },
      png,
      imgUrl,
      pdf,
      wav,
      mp4,
      handle,
    ]
    const { content, dropped } = toLangChainContent(parts, ALL, "openai", "user")
    expect(dropped).toEqual([])
    expect(content).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "image", url: "https://x.test/a.png" },
      { type: "file", data: "JVBERi0=", mimeType: "application/pdf" },
      { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
      { type: "video", url: "https://x.test/a.mp4" },
      { type: "image", fileId: "file_abc" },
    ])
  })

  it("drops unsupported modalities and says why", () => {
    const { content, dropped } = toLangChainContent(
      [{ type: "text", text: "t" }, png, pdf, wav, mp4],
      DEFAULT_MODALITY_SUPPORT,
      "openai",
      "user",
    )
    expect(content).toEqual([
      { type: "text", text: "t" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
    expect(dropped).toEqual([
      { index: 2, type: "document", source: "data", reason: "modality_unsupported" },
      { index: 3, type: "audio", source: "data", reason: "modality_unsupported" },
      { index: 4, type: "video", source: "url", reason: "modality_unsupported" },
    ])
  })

  it("drops a url image when only inline images are supported", () => {
    const support = { ...ALL, image: { data: true, url: false } }
    const { dropped } = toLangChainContent([imgUrl], support, "ollama", "user")
    expect(dropped).toEqual([
      { index: 0, type: "image", source: "url", reason: "url_source_unsupported" },
    ])
  })

  it("drops a file handle the provider cannot resolve, and a foreign provider's handle", () => {
    expect(
      toLangChainContent([handle], { ...ALL, file: { image: false, pdf: false } }, "xai", "user")
        .dropped,
    ).toEqual([{ index: 0, type: "image", source: "file", reason: "file_source_unsupported" }])
    expect(toLangChainContent([handle], ALL, "anthropic", "user").dropped).toEqual([
      { index: 0, type: "image", source: "file", reason: "foreign_file_provider" },
    ])
    // No provider named: the route's provider is assumed to have minted it.
    const anon = { type: "image", source: { type: "file", value: "f" } } as const
    expect(toLangChainContent([anon], ALL, "anthropic", "user").dropped).toEqual([])
  })

  it("gates file handles per part type", () => {
    const docHandle = {
      type: "document",
      source: { type: "file", value: "file_1", mimeType: "application/pdf" },
    } as const
    const { content, dropped } = toLangChainContent(
      [handle, docHandle],
      { ...ALL, file: { image: false, pdf: true } },
      "openai",
      "user",
    )
    expect(dropped).toEqual([
      { index: 0, type: "image", source: "file", reason: "file_source_unsupported" },
    ])
    expect(content).toEqual([{ type: "file", fileId: "file_1", mimeType: "application/pdf" }])
  })

  it("emits the legacy image_url block for ollama and mistral only", () => {
    expect(toLangChainContent([png], ALL, "ollama", "user").content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ])
    expect(toLangChainContent([imgUrl], ALL, "mistral", "user").content).toEqual([
      { type: "image_url", image_url: { url: "https://x.test/a.png" } },
    ])
    expect(toLangChainContent([png], ALL, "openai", "user").content).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
  })

  it("a document is a PDF or nothing", () => {
    const notPdf = {
      type: "document",
      source: { type: "data", value: "x", mimeType: "text/csv" },
    } as const
    const urlNoMime = {
      type: "document",
      source: { type: "url", value: "https://x.test/a.pdf" },
    } as const
    const urlPdf = {
      type: "document",
      source: { type: "url", value: "https://x.test/a.pdf", mimeType: "application/pdf" },
    } as const
    const { content, dropped } = toLangChainContent(
      [notPdf, urlNoMime, urlPdf],
      ALL,
      "openai",
      "user",
    )
    expect(dropped).toEqual([
      { index: 0, type: "document", source: "data", reason: "document_not_pdf" },
      { index: 1, type: "document", source: "url", reason: "document_not_pdf" },
    ])
    expect(content).toEqual([
      { type: "file", url: "https://x.test/a.pdf", mimeType: "application/pdf" },
    ])
  })

  it("an array that loses every block becomes an empty string", () => {
    expect(toLangChainContent([wav], DEFAULT_MODALITY_SUPPORT, "openai", "user").content).toBe("")
    expect(toLangChainContent([], ALL, "openai", "user").content).toBe("")
  })
})

describe("toLangChainContent — tool position", () => {
  it("additionally requires the tool-message flags; audio and video never reach the model", () => {
    const support = { ...ALL, toolResult: { image: true, pdf: false } }
    const { content, dropped } = toLangChainContent(
      [{ type: "text", text: "r" }, png, pdf, wav],
      support,
      "openai",
      "tool",
    )
    expect(content).toEqual([
      { type: "text", text: "r" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
    expect(dropped).toEqual([
      { index: 2, type: "document", source: "data", reason: "tool_result_media_unsupported" },
      { index: 3, type: "audio", source: "data", reason: "tool_result_media_unsupported" },
    ])
  })
})

describe("formatDroppedPartsWarning", () => {
  it("names the model, each part and its reason, and points at the capability document", () => {
    const text = formatDroppedPartsWarning({
      provider: "openai",
      model: "gpt-5-mini",
      routeId: "/chat",
      parts: [
        { index: 1, type: "audio", source: "data", reason: "modality_unsupported" },
        { index: 2, type: "image", source: "url", reason: "url_source_unsupported" },
      ],
    })
    expect(text).toBe(
      "B4: dropped 2 content part(s) the model cannot use (openai/gpt-5-mini): audio/data (modality_unsupported), image/url (url_source_unsupported). GET /agui/%2Fchat lists what this route accepts.",
    )
  })

  it("omits the capability pointer without a route id", () => {
    expect(
      formatDroppedPartsWarning({
        provider: "ollama",
        model: "llama3",
        parts: [{ index: 0, type: "video", source: "url", reason: "modality_unsupported" }],
      }),
    ).toBe(
      "B4: dropped 1 content part(s) the model cannot use (ollama/llama3): video/url (modality_unsupported).",
    )
  })
})
