// packages/ag-ui/test/content-parts-shape.test.ts
import type { ContentPart, DataSource, FileSource, UrlSource } from "@ag-ui/core"
import { ContentPartSchema } from "@ag-ui/core/schemas"
import {
  type B4ContentPart,
  type B4DataSource,
  type B4FileSource,
  type B4MediaPart,
  type B4TextPart,
  type B4UrlSource,
  isContentPart,
} from "@b4run/sdk"
import { expect, test } from "vitest"

/**
 * The SDK's part type is a structural copy of the protocol's. Either direction
 * failing to assign means a 1.x addition widened one side: update
 * `packages/sdk/src/content-parts.ts` deliberately rather than letting the
 * runtime carry a shape it does not know.
 */
type AssignableBothWays<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
/** Mutual assignability misses an added optional field; compare the key sets too. */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : never
  : never

const pinned: AssignableBothWays<ContentPart, B4ContentPart> = true
const textKeys: SameKeys<Extract<ContentPart, { type: "text" }>, B4TextPart> = true
const imageKeys: SameKeys<Extract<ContentPart, { type: "image" }>, B4MediaPart> = true
const audioKeys: SameKeys<Extract<ContentPart, { type: "audio" }>, B4MediaPart> = true
const videoKeys: SameKeys<Extract<ContentPart, { type: "video" }>, B4MediaPart> = true
const documentKeys: SameKeys<Extract<ContentPart, { type: "document" }>, B4MediaPart> = true
const dataKeys: SameKeys<DataSource, B4DataSource> = true
const urlKeys: SameKeys<UrlSource, B4UrlSource> = true
const fileKeys: SameKeys<FileSource, B4FileSource> = true

test("B4ContentPart and ContentPart are mutually assignable with identical key sets", () => {
  expect([
    pinned,
    textKeys,
    imageKeys,
    audioKeys,
    videoKeys,
    documentKeys,
    dataKeys,
    urlKeys,
    fileKeys,
  ]).toEqual(Array(9).fill(true))
})

const corpus: ReadonlyArray<readonly [string, unknown]> = [
  ["text part", { type: "text", text: "hi" }],
  ["non-string id", { type: "text", text: "hi", id: 1 }],
  ["non-string text", { type: "text", text: 1 }],
  [
    "url source with non-string mimeType",
    {
      type: "image",
      source: { type: "url", value: "https://x.test/a.png", mimeType: 1 },
    },
  ],
  [
    "file source with non-string provider",
    { type: "image", source: { type: "file", value: "f", provider: 1 } },
  ],
  ["media part without source", { type: "image" }],
  ["part as array", [{ type: "text", text: "hi" }]],
  ["source as array", { type: "image", source: [] }],
  ["null metadata", { type: "text", text: "hi", metadata: null }],
  ["string metadata", { type: "text", text: "hi", metadata: "m" }],
  ["array metadata", { type: "text", text: "hi", metadata: [1] }],
]

test.each(corpus)("isContentPart agrees with ContentPartSchema: %s", (_name, value) => {
  expect(isContentPart(value)).toBe(ContentPartSchema.safeParse(value).success)
})
