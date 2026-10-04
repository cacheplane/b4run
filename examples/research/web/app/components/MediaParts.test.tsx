import type { B4ContentPart } from "@b4run/sdk"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { MediaParts } from "./MediaParts"

function render(parts: readonly B4ContentPart[]): string {
  return renderToStaticMarkup(<MediaParts parts={parts} />)
}

describe("MediaParts", () => {
  test("an inline image becomes an <img> with a data: URL", () => {
    const markup = render([
      { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
    ])
    expect(markup).toContain('src="data:image/png;base64,AAAA"')
    expect(markup).toContain('alt="image"')
    expect(markup).toMatch(/<img[^>]*class="[^"]*max-w-full/)
  })

  test("a url image loads from its URL", () => {
    const markup = render([{ type: "image", source: { type: "url", value: "https://x/a.png" } }])
    expect(markup).toContain('<img src="https://x/a.png"')
  })

  test("an image's filename, when it carries one, is its alt text", () => {
    const markup = render([
      {
        type: "image",
        source: { type: "data", value: "AAAA", mimeType: "image/png" },
        metadata: { filename: "chart.png" },
      },
    ])
    expect(markup).toContain('alt="chart.png"')
  })

  test("a document is a download link chip", () => {
    const markup = render([
      {
        type: "document",
        source: { type: "data", value: "JVBE", mimeType: "application/pdf" },
        metadata: { filename: "paper.pdf" },
      },
    ])
    expect(markup).toMatch(
      /<a[^>]*href="data:application\/pdf;base64,JVBE"[^>]*download="document.pdf"/,
    )
    expect(markup).toContain("paper.pdf")
  })

  test("a provider file handle is a chip with the handle and no link", () => {
    const markup = render([
      { type: "document", source: { type: "file", value: "file_123", provider: "openai" } },
    ])
    expect(markup).toContain("file_123")
    expect(markup).not.toContain("<a")
    expect(markup).not.toContain("<img")
  })

  test("an image held as a provider file handle cannot be drawn, so it is a chip too", () => {
    const markup = render([{ type: "image", source: { type: "file", value: "file_9" } }])
    expect(markup).toContain("file_9")
    expect(markup).not.toContain("<img")
  })

  test("audio and video get the native players", () => {
    const markup = render([
      { type: "audio", source: { type: "data", value: "UklG", mimeType: "audio/wav" } },
      { type: "video", source: { type: "url", value: "https://x/v.mp4" } },
    ])
    expect(markup).toMatch(/<audio[^>]*controls=""[^>]*src="data:audio\/wav;base64,UklG"/)
    expect(markup).toMatch(/<video[^>]*controls=""[^>]*src="https:\/\/x\/v.mp4"/)
  })

  test("text parts are not drawn: the bubble or card already shows the text", () => {
    expect(render([{ type: "text", text: "only words" }])).toBe("")
    expect(
      render([
        { type: "text", text: "a caption" },
        { type: "image", source: { type: "url", value: "https://x/a.png" } },
      ]),
    ).not.toContain("a caption")
  })

  test("a link is never built from a non-web URL", () => {
    const markup = render([
      { type: "document", source: { type: "url", value: "javascript:alert(1)" } },
    ])
    expect(markup).not.toContain("href=")
    expect(markup).toContain("document")
  })

  test("an image whose data claims a non-image MIME type is a chip, never a src", () => {
    const markup = render([
      { type: "image", source: { type: "data", value: "PGgxPg==", mimeType: "text/html" } },
    ])
    expect(markup).not.toContain("<img")
    expect(markup).not.toContain("src=")
    expect(markup).toContain("image")
  })

  test("a document outside the allow-list is a chip with no link", () => {
    const markup = render([
      {
        type: "document",
        source: { type: "data", value: "TVo=", mimeType: "application/x-msdownload" },
      },
    ])
    expect(markup).not.toContain("href=")
  })

  test("the download name comes from the MIME type, not the part's filename", () => {
    const markup = render([
      {
        type: "document",
        source: { type: "data", value: "JVBE", mimeType: "application/pdf" },
        metadata: { filename: "report.exe" },
      },
    ])
    expect(markup).toContain('download="document.pdf"')
    expect(markup).not.toContain('download="report.exe"')
    // Still shown as the label: it is only text.
    expect(markup).toContain("report.exe")
  })
})
