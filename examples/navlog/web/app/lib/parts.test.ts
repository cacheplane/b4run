import type { B4MediaPart } from "@b4run/sdk"
import { describe, expect, test } from "vitest"
import { blocksToParts, dataUrl, mediaParts, partsOf } from "./parts"

const png: B4MediaPart = {
  type: "image",
  source: { type: "data", value: "AAAA", mimeType: "image/png" },
}

describe("partsOf", () => {
  test("a string is one text part; an array keeps valid parts; junk yields []", () => {
    expect(partsOf("hi")).toEqual([{ type: "text", text: "hi" }])
    expect(partsOf([{ type: "text", text: "a" }, png, null])).toEqual([
      { type: "text", text: "a" },
      png,
    ])
    expect(partsOf(42)).toEqual([])
  })

  test("an empty string has no parts, so it cannot count as content", () => {
    expect(partsOf("")).toEqual([])
  })
})

describe("mediaParts / dataUrl", () => {
  test("keeps non-text parts; a data source becomes a data: URL, a url source its URL, a file handle undefined", () => {
    expect(mediaParts([{ type: "text", text: "a" }, png])).toEqual([png])
    expect(dataUrl(png)).toBe("data:image/png;base64,AAAA")
    expect(dataUrl({ type: "image", source: { type: "url", value: "https://x/a.png" } })).toBe(
      "https://x/a.png",
    )
    expect(dataUrl({ type: "image", source: { type: "file", value: "file_1" } })).toBeUndefined()
  })
})

describe("blocksToParts", () => {
  test("maps LangChain v1 blocks from a checkpoint back to AG-UI parts", () => {
    expect(
      blocksToParts([
        { type: "text", text: "t" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", url: "https://x/a.png" },
        { type: "file", data: "JVBE", mimeType: "application/pdf" },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ]),
    ).toEqual([
      { type: "text", text: "t" },
      png,
      { type: "image", source: { type: "url", value: "https://x/a.png" } },
      { type: "document", source: { type: "data", value: "JVBE", mimeType: "application/pdf" } },
      { type: "image", source: { type: "data", value: "BBBB", mimeType: "image/png" } },
    ])
  })

  test("maps provider file handles, audio, and a remote legacy image_url", () => {
    expect(
      blocksToParts([
        { type: "image", fileId: "file_1", mimeType: "image/png" },
        { type: "audio", data: "UklG", mimeType: "audio/wav" },
        { type: "image_url", image_url: "https://x/b.png" },
      ]),
    ).toEqual([
      { type: "image", source: { type: "file", value: "file_1", mimeType: "image/png" } },
      { type: "audio", source: { type: "data", value: "UklG", mimeType: "audio/wav" } },
      { type: "image", source: { type: "url", value: "https://x/b.png" } },
    ])
  })

  test("a string is one text part; blocks it cannot map are skipped, never thrown on", () => {
    expect(blocksToParts("hello")).toEqual([{ type: "text", text: "hello" }])
    expect(
      blocksToParts([
        null,
        { type: "image", source: "irrelevant" },
        { type: "image", data: "AAAA" },
        { type: "tool_use", id: "x" },
        { type: "text", text: "kept" },
      ]),
    ).toEqual([{ type: "text", text: "kept" }])
    expect(blocksToParts(undefined)).toEqual([])
  })

  test("an AG-UI part that is already in the checkpoint passes through", () => {
    expect(blocksToParts([png])).toEqual([png])
  })
})
