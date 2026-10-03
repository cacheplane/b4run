import { describe, expect, test } from "vitest"
import {
  buildTranscriptItems,
  type TranscriptMessage,
  titleFor,
  toolResultText,
  userText,
} from "./transcript"

function toolCall(id: string, name: string) {
  return { id, type: "function" as const, function: { name, arguments: '{"path":"corpus/a.md"}' } }
}

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

describe("toolResultText", () => {
  test("returns a string result as is", () => {
    expect(toolResultText('{"ok":true}')).toBe('{"ok":true}')
  })
  test("concatenates text parts in order and skips media", () => {
    expect(
      toolResultText([
        { type: "text", text: "a" },
        { type: "image", source: { type: "url", value: "https://x.test/i.png" } },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab")
  })
  test("yields an empty string for anything else", () => {
    expect(toolResultText(undefined)).toBe("")
    expect(toolResultText([{ type: "text", text: 5 }])).toBe("")
  })
})

describe("buildTranscriptItems", () => {
  test("keeps user and assistant turns in order", () => {
    const items = buildTranscriptItems([
      { id: "m1", role: "user", content: "hi" },
      { id: "m2", role: "assistant", content: "hello" },
    ])
    expect(items).toEqual([
      { kind: "user", id: "m1", text: "hi" },
      { kind: "assistant", id: "m2", text: "hello" },
    ])
  })

  test("pairs each tool call with the tool message that answers it", () => {
    const messages: readonly TranscriptMessage[] = [
      { id: "m1", role: "assistant", toolCalls: [toolCall("call-1", "readDoc")] },
      { id: "m2", role: "tool", toolCallId: "call-1", content: "the doc" },
    ]
    const items = buildTranscriptItems(messages)
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      kind: "toolCall",
      id: "call-1",
      toolCall: toolCall("call-1", "readDoc"),
      toolResult: messages[1],
    })
  })

  test("leaves a still-running tool call unpaired instead of guessing", () => {
    const items = buildTranscriptItems([
      { id: "m1", role: "assistant", toolCalls: [toolCall("call-1", "runBash")] },
      { id: "m2", role: "tool", toolCallId: "some-other-call", content: "unrelated" },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).not.toHaveProperty("toolResult")
  })

  test("emits an assistant message's text before its tool calls, in call order", () => {
    const items = buildTranscriptItems([
      {
        id: "m1",
        role: "assistant",
        content: "Searching the corpus.",
        toolCalls: [toolCall("call-1", "searchCorpus"), toolCall("call-2", "readDoc")],
      },
    ])
    expect(items.map((item) => item.kind)).toEqual(["assistant", "toolCall", "toolCall"])
    expect(items.map((item) => item.id)).toEqual(["m1", "call-1", "call-2"])
  })

  test("drops empty text so a streaming placeholder is not an empty bubble", () => {
    expect(buildTranscriptItems([{ id: "m1", role: "assistant", content: "" }])).toEqual([])
    expect(buildTranscriptItems([{ id: "m1", role: "assistant" }])).toEqual([])
  })

  test("carries an activity message through with its type and content intact", () => {
    const items = buildTranscriptItems([
      { id: "m1", role: "activity", activityType: "b4.plan", content: { todos: [] } },
    ])
    expect(items).toEqual([
      { kind: "activity", id: "m1", activityType: "b4.plan", content: { todos: [] } },
    ])
  })

  test("keeps reasoning but drops system and developer prompt plumbing", () => {
    const items = buildTranscriptItems([
      { id: "m1", role: "system", content: "you are a research agent" },
      { id: "m2", role: "developer", content: "internal" },
      { id: "m3", role: "reasoning", content: "considering the corpus" },
    ])
    expect(items).toEqual([{ kind: "reasoning", id: "m3", text: "considering the corpus" }])
  })

  test("pairs a tool result that arrives before its call", () => {
    // Ordering is not guaranteed by the transport, and an unpaired call renders
    // as permanently running.
    const items = buildTranscriptItems([
      { id: "m1", role: "tool", toolCallId: "call-1", content: "done" },
      { id: "m2", role: "assistant", toolCalls: [toolCall("call-1", "task")] },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveProperty("toolResult")
  })
})

const png = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } }

describe("buildTranscriptItems with content parts", () => {
  test("a user message with media carries its parts beside its text", () => {
    const items = buildTranscriptItems([
      { id: "m1", role: "user", content: [{ type: "text", text: "what is this?" }, png] },
    ])
    expect(items).toEqual([
      {
        kind: "user",
        id: "m1",
        text: "what is this?",
        parts: [{ type: "text", text: "what is this?" }, png],
      },
    ])
  })

  test("an image-only user message is kept; only a message with no text and no media is dropped", () => {
    expect(buildTranscriptItems([{ id: "m1", role: "user", content: [png] }])).toEqual([
      { kind: "user", id: "m1", text: "", parts: [png] },
    ])
    expect(buildTranscriptItems([{ id: "m1", role: "user", content: "" }])).toEqual([])
    expect(buildTranscriptItems([{ id: "m1", role: "user", content: [] }])).toEqual([])
  })

  test("a text-only part list adds no parts, so it renders exactly like a string", () => {
    expect(
      buildTranscriptItems([{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }]),
    ).toEqual([{ kind: "user", id: "m1", text: "hi" }])
  })

  test("a tool result with media carries its parts on toolResult", () => {
    const content = [{ type: "text", text: "Chart: revenue" }, png]
    const items = buildTranscriptItems([
      { id: "m1", role: "assistant", toolCalls: [toolCall("call-1", "renderChart")] },
      { id: "m2", role: "tool", toolCallId: "call-1", content },
    ])
    expect(items).toEqual([
      {
        kind: "toolCall",
        id: "call-1",
        toolCall: toolCall("call-1", "renderChart"),
        toolResult: { id: "m2", role: "tool", toolCallId: "call-1", content, parts: content },
      },
    ])
  })
})

describe("buildTranscriptItems with drop notices", () => {
  const dropped = [
    { index: 1, type: "image", source: "data", reason: "tool_result_media_unsupported" },
  ]

  test("a tool-result notice follows the tool call it names", () => {
    const items = buildTranscriptItems(
      [
        { id: "m1", role: "user", content: "chart it" },
        {
          id: "m2",
          role: "assistant",
          toolCalls: [toolCall("call-1", "renderChart"), toolCall("call-2", "readDoc")],
        },
        { id: "m3", role: "assistant", content: "Here is the chart." },
      ],
      [{ provider: "openai", model: "gpt-5-mini", toolCallId: "call-1", parts: dropped }],
    )
    expect(items.map((item) => item.kind)).toEqual([
      "user",
      "toolCall",
      "notice",
      "toolCall",
      "assistant",
    ])
    expect(items[2]).toEqual({
      kind: "notice",
      id: "notice-0",
      toolCallId: "call-1",
      parts: dropped,
    })
  })

  test("a user-turn notice (no toolCallId) follows the newest user item", () => {
    const userDrop = [{ index: 1, type: "audio", source: "data", reason: "modality_unsupported" }]
    const items = buildTranscriptItems(
      [
        { id: "m1", role: "user", content: "first" },
        { id: "m2", role: "assistant", content: "ok" },
        { id: "m3", role: "user", content: [{ type: "text", text: "listen" }, png] },
        { id: "m4", role: "assistant", content: "I cannot hear that." },
      ],
      [{ parts: userDrop }],
    )
    expect(items.map((item) => item.id)).toEqual(["m1", "m2", "m3", "notice-0", "m4"])
    expect(items[3]).toEqual({ kind: "notice", id: "notice-0", parts: userDrop })
  })

  test("a user-turn notice stamped with its turn stays after that turn once a later turn arrives", () => {
    const userDrop = [{ index: 1, type: "audio", source: "data", reason: "modality_unsupported" }]
    const items = buildTranscriptItems(
      [
        { id: "m1", role: "user", content: [{ type: "text", text: "listen" }, png] },
        { id: "m2", role: "assistant", content: "I cannot hear that." },
        { id: "m3", role: "user", content: "then summarize the corpus" },
        { id: "m4", role: "assistant", content: "Here is the summary." },
      ],
      [{ anchorMessageId: "m1", parts: userDrop }],
    )
    expect(items.map((item) => item.id)).toEqual(["m1", "notice-0", "m2", "m3", "m4"])
    expect(items[1]).toEqual({ kind: "notice", id: "notice-0", parts: userDrop })
  })

  test("a notice anchored to a user message that is gone is appended rather than lost", () => {
    const items = buildTranscriptItems(
      [{ id: "m1", role: "user", content: "hi" }],
      [{ anchorMessageId: "m-gone", parts: dropped }],
    )
    expect(items.map((item) => item.id)).toEqual(["m1", "notice-0"])
  })

  test("a notice with nothing to anchor to is appended rather than lost", () => {
    const items = buildTranscriptItems(
      [{ id: "m1", role: "assistant", content: "hi" }],
      [{ toolCallId: "call-unknown", parts: dropped }, { parts: dropped }],
    )
    expect(items.map((item) => item.id)).toEqual(["m1", "notice-0", "notice-1"])
  })

  test("several notices on one tool call keep their arrival order", () => {
    const items = buildTranscriptItems(
      [{ id: "m1", role: "assistant", toolCalls: [toolCall("call-1", "renderChart")] }],
      [
        { toolCallId: "call-1", parts: dropped },
        { toolCallId: "call-1", parts: dropped },
      ],
    )
    expect(items.map((item) => item.id)).toEqual(["call-1", "notice-0", "notice-1"])
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
