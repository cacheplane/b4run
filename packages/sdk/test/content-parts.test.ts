// packages/sdk/test/content-parts.test.ts
import { describe, expect, it } from "vitest"
import {
  type B4ContentPart,
  contentPartsText,
  isContentPart,
  isContentPartArray,
} from "../src/content-parts.ts"

const image: B4ContentPart = {
  type: "image",
  source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" },
}

describe("isContentPartArray", () => {
  it("accepts text and media parts with a valid source", () => {
    expect(isContentPartArray([{ type: "text", text: "hi" }, image])).toBe(true)
    expect(
      isContentPartArray([
        {
          type: "document",
          source: { type: "url", value: "https://x.test/a.pdf" },
        },
        {
          type: "audio",
          source: { type: "file", value: "file_123", provider: "openai" },
        },
      ]),
    ).toBe(true)
  })

  it("rejects non-arrays, non-object entries, unknown part types and malformed sources", () => {
    expect(isContentPartArray("hi")).toBe(false)
    expect(isContentPartArray([null])).toBe(false)
    expect(isContentPartArray([{ type: "reasoning", text: "x" }])).toBe(false)
    expect(isContentPartArray([{ type: "image", source: { type: "blob", value: "x" } }])).toBe(
      false,
    )
    expect(isContentPartArray([{ type: "image", source: { type: "data", value: "x" } }])).toBe(
      false,
    ) // data needs mimeType
    expect(isContentPartArray([{ type: "text" }])).toBe(false)
  })

  it("accepts an empty array", () => {
    expect(isContentPartArray([])).toBe(true)
  })
})

describe("contentPartsText", () => {
  it("returns a string as is and concatenates text parts in order, skipping media", () => {
    expect(contentPartsText("plain")).toBe("plain")
    expect(
      contentPartsText([{ type: "text", text: "a" }, image, { type: "text", text: "b" }]),
    ).toBe("ab")
    expect(contentPartsText([image])).toBe("")
  })
})

describe("isContentPart", () => {
  it.each<[string, unknown, boolean]>([
    ["text part", { type: "text", text: "hi" }, true],
    ["non-string id", { type: "text", text: "hi", id: 1 }, false],
    ["non-string text", { type: "text", text: 1 }, false],
    [
      "url source with non-string mimeType",
      {
        type: "image",
        source: { type: "url", value: "https://x.test/a.png", mimeType: 1 },
      },
      false,
    ],
    [
      "file source with non-string provider",
      { type: "image", source: { type: "file", value: "f", provider: 1 } },
      false,
    ],
    ["media part without source", { type: "image" }, false],
    ["part as array", [{ type: "text", text: "hi" }], false],
    ["source as array", { type: "image", source: [] }, false],
    ["null metadata", { type: "text", text: "hi", metadata: null }, false],
    ["string metadata", { type: "text", text: "hi", metadata: "m" }, true],
    ["array metadata", { type: "text", text: "hi", metadata: [1] }, true],
  ])("%s", (_name, value, expected) => {
    expect(isContentPart(value)).toBe(expected)
  })

  it("rejects a part list with one bad element", () => {
    expect(
      isContentPartArray([
        { type: "text", text: "ok" },
        { type: "text", text: 1 },
      ]),
    ).toBe(false)
  })
})
