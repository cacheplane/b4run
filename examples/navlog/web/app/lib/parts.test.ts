import type { B4MediaPart } from "@b4run/sdk"
import { describe, expect, test } from "vitest"
import { dataUrl, mediaParts, partsOf } from "./parts"

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
