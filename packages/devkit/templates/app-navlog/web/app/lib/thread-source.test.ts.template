import { beforeEach, describe, expect, test } from "vitest"
import { createLocalThreadSource, titleFor, userText } from "./thread-source.js"

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  } as Storage
}

describe("local thread source", () => {
  let storage: Storage

  beforeEach(() => {
    storage = memoryStorage()
  })

  test("starts empty", () => {
    expect(createLocalThreadSource(storage).list()).toEqual([])
  })

  test("creates a thread with an id and no title", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    expect(thread.id).toMatch(/[0-9a-f-]{36}/)
    expect(thread.title).toBeUndefined()
    expect(source.list()).toEqual([thread])
  })

  test("titles a thread from its first user message and keeps the first only", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    source.touch(thread.id, "Compare the agent architectures in the corpus")
    source.touch(thread.id, "And summarize them")
    expect(source.list()[0]?.title).toBe("Compare the agent architectures in the corpus")
  })

  test("truncates a long title", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    source.touch(thread.id, "x".repeat(200))
    const title = source.list()[0]?.title ?? ""
    expect(title.length).toBeLessThanOrEqual(80)
  })

  test("lists most recently active first", () => {
    const source = createLocalThreadSource(storage)
    const first = source.create()
    const second = source.create()
    source.touch(first.id, "older")
    source.touch(second.id, "newer")
    expect(source.list().map((thread) => thread.id)).toEqual([second.id, first.id])
  })

  test("survives a reload through storage", () => {
    const source = createLocalThreadSource(storage)
    const thread = source.create()
    source.touch(thread.id, "persisted")
    expect(createLocalThreadSource(storage).list()[0]?.title).toBe("persisted")
  })

  test("tolerates corrupt storage rather than throwing", () => {
    storage.setItem("b4.workbench.threads", "{not json")
    expect(createLocalThreadSource(storage).list()).toEqual([])
  })

  test("ignores a touch for an unknown thread", () => {
    const source = createLocalThreadSource(storage)
    source.touch("nope", "orphan")
    expect(source.list()).toEqual([])
  })
})

const png = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } }

describe("userText", () => {
  test("passes a plain string through", () => {
    expect(userText("hello")).toBe("hello")
  })

  test("joins the text parts of multimodal content and drops the rest", () => {
    expect(
      userText([
        { type: "text", text: "look at " },
        { type: "image", source: { type: "url", value: "https://example.test/x.png" } },
        { type: "text", text: "this" },
      ]),
    ).toBe("look at this")
  })

  test("yields nothing rather than [object Object] for content it cannot read", () => {
    expect(userText(undefined)).toBe("")
    expect(userText([{ type: "image" }])).toBe("")
  })
})

describe("titleFor", () => {
  test("a message with text is titled by its text", () => {
    expect(titleFor("hello")).toBe("hello")
    expect(titleFor([{ type: "text", text: "look" }, png])).toBe("look")
  })

  test("an image-only message is titled by what it carries, not left blank", () => {
    expect(titleFor([png])).toBe("(image)")
    expect(
      titleFor([{ type: "audio", source: { type: "data", value: "UklG", mimeType: "audio/wav" } }]),
    ).toBe("(audio)")
  })

  test("nothing to show is the empty string, which the rail leaves untitled", () => {
    expect(titleFor("")).toBe("")
    expect(titleFor(42)).toBe("")
  })
})
