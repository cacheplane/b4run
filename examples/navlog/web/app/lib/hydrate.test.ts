import { describe, expect, test } from "vitest"
import { hydrateThreadState } from "./hydrate.js"
import { buildTranscriptItems, userText } from "./transcript.js"

const STATE = {
  values: {
    context: "",
    messages: [
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "HumanMessage"],
        kwargs: { content: "What does the POH give for cruise at 4500 ft?", id: "m1" },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          content: "",
          id: "m2",
          tool_calls: [
            {
              name: "readDoc",
              args: { path: "poh/cruise-performance.md" },
              id: "call_readDoc_0_0",
              type: "tool_call",
            },
          ],
        },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          content: '{"path":"poh/cruise-performance.md","content":"Figure 5-7"}',
          tool_call_id: "call_readDoc_0_0",
          name: "readDoc",
          id: "m3",
        },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          content: "At 2400 RPM the POH gives 109.75 KTAS and 7.0 GPH.",
          id: "m4",
          tool_calls: [],
        },
      },
    ],
    todos: [
      { content: "Read the cruise table", status: "completed" },
      { content: "Compute the navlog", status: "in_progress" },
    ],
  },
}

/**
 * The SAME conversation as `STATE`, in the complete shape a live checkpoint DB
 * actually stores: every `kwargs` key LangChain writes, not just the ones this
 * mapper reads. Real reproduction, trimmed only of usage numbers.
 */
const FULL_STATE = {
  values: {
    context: "",
    messages: [
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "HumanMessage"],
        kwargs: {
          content: "What does the POH give for cruise at 4500 ft?",
          additional_kwargs: {},
          response_metadata: {},
          id: "h-real-1",
        },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          content: "",
          additional_kwargs: {
            tool_calls: [
              {
                index: 0,
                id: "call_readDoc_0_0",
                type: "function",
                function: {
                  name: "readDoc",
                  arguments: '{"path":"poh/cruise-performance.md"}',
                },
              },
            ],
          },
          response_metadata: { model_provider: "openai" },
          tool_call_chunks: [
            {
              name: "readDoc",
              args: '{"path":"poh/cruise-performance.md"}',
              id: "call_readDoc_0_0",
              index: 0,
              type: "tool_call_chunk",
            },
          ],
          tool_calls: [
            {
              name: "readDoc",
              args: { path: "poh/cruise-performance.md" },
              id: "call_readDoc_0_0",
              type: "tool_call",
            },
          ],
          id: "chatcmpl-ewwyWCZa7FNPznQA",
          invalid_tool_calls: [],
        },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          content: '{"path":"poh/cruise-performance.md","content":"Figure 5-7"}',
          tool_call_id: "call_readDoc_0_0",
          name: "readDoc",
          additional_kwargs: {},
          response_metadata: {},
          status: "success",
          metadata: {},
          id: "t-real-1",
        },
      },
      {
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          content: "At 2400 RPM the POH gives 109.75 KTAS and 7.0 GPH.",
          additional_kwargs: {},
          response_metadata: { model_provider: "openai", finish_reason: "stop" },
          tool_call_chunks: [],
          tool_calls: [],
          id: "chatcmpl-ewwyWCZa7FNPznQB",
          invalid_tool_calls: [],
        },
      },
    ],
    todos: [
      { content: "Read the cruise table", status: "completed" },
      { content: "Compute the navlog", status: "in_progress" },
    ],
  },
}

describe("hydrateThreadState", () => {
  test("maps each LangChain envelope to its transcript role", () => {
    const { messages } = hydrateThreadState(STATE)
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ])
  })

  test("stringifies tool-call args, because /state gives an object and the transcript wants a string", () => {
    const { messages } = hydrateThreadState(STATE)
    const assistant = messages[1]
    expect(assistant).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "call_readDoc_0_0",
          type: "function",
          function: { name: "readDoc", arguments: '{"path":"poh/cruise-performance.md"}' },
        },
      ],
    })
  })

  test("uses the tool message content directly — there is no second envelope on this path", () => {
    const { messages } = hydrateThreadState(STATE)
    expect(messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_readDoc_0_0",
      content: '{"path":"poh/cruise-performance.md","content":"Figure 5-7"}',
    })
  })

  test("re-seeds the plan from the checkpointed todos", () => {
    expect(hydrateThreadState(STATE).todos).toEqual([
      { content: "Read the cruise table", status: "completed" },
      { content: "Compute the navlog", status: "in_progress" },
    ])
  })

  test("feeds buildTranscriptItems: text, then a paired tool card", () => {
    const items = buildTranscriptItems(hydrateThreadState(STATE).messages)
    expect(items.map((item) => item.kind)).toEqual(["user", "toolCall", "assistant"])
    expect(items[1]).toMatchObject({
      kind: "toolCall",
      toolResult: { toolCallId: "call_readDoc_0_0" },
    })
  })

  test("gives every message an id, minting one when the envelope has none", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "hi" } },
        ],
      },
    })
    expect(messages[0]?.id).toBe("hydrated-1")
  })

  test("mints ids that are stable across repeat hydrations of the same payload", () => {
    const payload = {
      values: {
        messages: [
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "a" } },
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "b" } },
        ],
      },
    }
    const first = hydrateThreadState(payload).messages.map((message) => message.id)
    const second = hydrateThreadState(payload).messages.map((message) => message.id)
    expect(first).toEqual(second)
    expect(first).toEqual(["hydrated-1", "hydrated-2"])
  })

  test("maps HumanMessage block arrays to parts, skipping blocks it cannot read, so userText still applies", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "HumanMessage"],
            kwargs: {
              content: [
                { type: "text", text: "look at this" },
                { type: "image", source: "irrelevant" },
              ],
              id: "u1",
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "user" })
    const userMessage = messages[0] as { content: unknown }
    expect(userText(userMessage.content)).toBe("look at this")
    const items = buildTranscriptItems(messages)
    expect(items).toEqual([{ kind: "user", id: messages[0]?.id, text: "look at this" }])
  })

  test("maps a HumanMessage's LangChain v1 media blocks back to AG-UI parts", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: {
              content: [
                { type: "text", text: "what is this?" },
                { type: "image", data: "AAAA", mimeType: "image/png" },
              ],
              id: "u1",
              response_metadata: { output_version: "v1" },
            },
          },
        ],
      },
    })
    const png = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } }
    expect(messages).toEqual([
      { id: "u1", role: "user", content: [{ type: "text", text: "what is this?" }, png] },
    ])
    expect(buildTranscriptItems(messages)).toEqual([
      {
        kind: "user",
        id: "u1",
        text: "what is this?",
        parts: [{ type: "text", text: "what is this?" }, png],
      },
    ])
  })

  test("a ToolMessage's b4_content_parts win over its content, so the UI sees the media the model may not have", () => {
    const parts = [
      { type: "text", text: "Chart: revenue" },
      { type: "image", source: { type: "data", value: "PHN2Zz4=", mimeType: "image/svg+xml" } },
    ]
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["langchain_core", "messages", "ToolMessage"],
            kwargs: {
              content: "Chart: revenue",
              tool_call_id: "call-1",
              additional_kwargs: { b4_content_parts: parts },
              id: "t1",
            },
          },
        ],
      },
    })
    expect(messages).toEqual([{ id: "t1", role: "tool", toolCallId: "call-1", content: parts }])
  })

  test("an invalid b4_content_parts list falls back to the content text", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["langchain_core", "messages", "ToolMessage"],
            kwargs: {
              content: "plain",
              tool_call_id: "call-1",
              additional_kwargs: { b4_content_parts: [{ type: "image", source: "bad" }] },
              id: "t1",
            },
          },
        ],
      },
    })
    expect(messages).toEqual([{ id: "t1", role: "tool", toolCallId: "call-1", content: "plain" }])
  })

  test("flattens content-block arrays for AIMessageChunk instead of emptying the message", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessageChunk"],
            kwargs: {
              content: [
                { type: "text", text: "Here is the answer." },
                { type: "tool_use", id: "ignored", name: "ignored" },
              ],
              id: "a1",
              tool_calls: [],
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "assistant", content: "Here is the answer." })
    const items = buildTranscriptItems(messages)
    expect(items).toEqual([{ kind: "assistant", id: "a1", text: "Here is the answer." }])
  })

  test("treats non-chunk AIMessage the same as AIMessageChunk", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessage"],
            kwargs: { content: "final answer", id: "a2", tool_calls: [] },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "assistant", content: "final answer" })
  })

  test("drops entries it does not understand instead of throwing", () => {
    const { messages, todos } = hydrateThreadState({
      values: {
        messages: [
          null,
          "nonsense",
          { lc: 1, type: "constructor", id: ["x", "y", "SystemMessage"], kwargs: { content: "s" } },
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "hi" } },
        ],
        todos: "not an array",
      },
    })
    expect(messages.map((message) => message.role)).toEqual(["user"])
    expect(todos).toEqual([])
  })

  test("drops a ToolMessage with no tool_call_id, which nothing could ever pair", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "ToolMessage"],
            kwargs: { content: "result", id: "t1", name: "readDoc" },
          },
        ],
      },
    })
    expect(messages).toEqual([])
  })

  test("degrades to empty rather than throwing on a malformed payload", () => {
    expect(hydrateThreadState(null)).toEqual({ messages: [], rawMessageCount: 0, todos: [] })
    expect(hydrateThreadState({})).toEqual({ messages: [], rawMessageCount: 0, todos: [] })
    expect(hydrateThreadState({ values: {} })).toEqual({
      messages: [],
      rawMessageCount: 0,
      todos: [],
    })
  })

  test("the empty result is a fresh array each call, since AbstractAgent mutates messages in place", () => {
    const a = hydrateThreadState(null)
    const b = hydrateThreadState({})
    expect(a.messages).not.toBe(b.messages)
    expect(a.todos).not.toBe(b.todos)
    ;(a.messages as unknown[]).push("leaked")
    expect(b.messages).toEqual([])
  })

  test("drops a tool call with no id, which nothing could ever pair", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessageChunk"],
            kwargs: {
              content: "",
              id: "a1",
              tool_calls: [{ name: "readDoc", args: {} }],
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "assistant", toolCalls: [] })
  })

  test("drops a tool call with a non-string name", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessageChunk"],
            kwargs: {
              content: "",
              id: "a1",
              tool_calls: [{ id: "call_1", name: 42, args: {} }],
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({ role: "assistant", toolCalls: [] })
  })

  test("defaults tool-call arguments to an empty object when args is absent", () => {
    const { messages } = hydrateThreadState({
      values: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["x", "y", "AIMessageChunk"],
            kwargs: {
              content: "",
              id: "a1",
              tool_calls: [{ id: "call_1", name: "readDoc" }],
            },
          },
        ],
      },
    })
    expect(messages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [{ function: { arguments: "{}" } }],
    })
  })

  test("toTodos filters non-record entries, invalid statuses, and empty content", () => {
    const { todos } = hydrateThreadState({
      values: {
        messages: [],
        todos: [
          null,
          "nonsense",
          { content: "", status: "pending" },
          { content: "   ", status: "pending" },
          { content: "valid", status: "not-a-status" },
          { content: "valid", status: "pending" },
        ],
      },
    })
    expect(todos).toEqual([{ content: "valid", status: "pending" }])
  })

  test("counts raw entries, including the ones it drops", () => {
    // The denominator `AppShell` uses to tell "this thread never ran" apart
    // from "this thread has history nothing here could read". Four entries in,
    // one mapped.
    const { messages, rawMessageCount } = hydrateThreadState({
      values: {
        messages: [
          null,
          "nonsense",
          { lc: 1, type: "constructor", id: ["x", "y", "SystemMessage"], kwargs: { content: "s" } },
          { lc: 1, type: "constructor", id: ["x", "y", "HumanMessage"], kwargs: { content: "hi" } },
        ],
      },
    })
    expect(messages).toHaveLength(1)
    expect(rawMessageCount).toBe(4)
  })

  test("counts a not_implemented envelope even though nothing can render it", () => {
    // LangChain serializes a class it cannot reconstruct as `type:
    // "not_implemented"` with no `kwargs` at all. Dropping it is right; NOT
    // counting it would make a checkpoint full of them look like a thread that
    // never ran, which is the exact silence `rawMessageCount` exists to break.
    const { messages, rawMessageCount } = hydrateThreadState({
      values: {
        messages: [
          { lc: 1, type: "not_implemented", id: ["langchain_core", "messages", "FunctionMessage"] },
        ],
      },
    })
    expect(messages).toEqual([])
    expect(rawMessageCount).toBe(1)
  })

  test("a genuinely empty checkpoint counts zero, so it stays indistinguishable from a new thread", () => {
    expect(hydrateThreadState({ values: { messages: [] } }).rawMessageCount).toBe(0)
    expect(hydrateThreadState({ values: { messages: "not an array" } }).rawMessageCount).toBe(0)
  })

  test("the full serialization shape maps identically to the trimmed fixture", () => {
    // `STATE` above is hand-trimmed to the keys this file reads, which is
    // exactly how a mapper passes its own tests while missing the real wire.
    // `FULL_STATE` is a real body captured from a live checkpoint DB — every
    // `kwargs` key LangChain actually writes, trimmed only of usage numbers —
    // so if a future refactor starts depending on a key's absence, or a full
    // envelope stops matching, this reds.
    const trimmed = hydrateThreadState(STATE).messages
    const full = hydrateThreadState(FULL_STATE).messages
    expect(full).toHaveLength(trimmed.length)
    expect(hydrateThreadState(FULL_STATE).rawMessageCount).toBe(
      hydrateThreadState(STATE).rawMessageCount,
    )
    // Ids are the one thing that legitimately differs: the real capture
    // carries the provider's own `chatcmpl-…` id where the trimmed fixture
    // says "m2". Everything else must match byte-for-byte.
    const withoutIds = (messages: readonly unknown[]) =>
      messages.map((message) => {
        const { id: _id, ...rest } = message as Record<string, unknown>
        return rest
      })
    expect(withoutIds(full)).toEqual(withoutIds(trimmed))
    // And the ids that ARE there are the real ones, not minted stand-ins.
    expect(full.map((message) => message.id)).toEqual([
      "h-real-1",
      "chatcmpl-ewwyWCZa7FNPznQA",
      "t-real-1",
      "chatcmpl-ewwyWCZa7FNPznQB",
    ])
  })

  test("the full fixture still feeds buildTranscriptItems as a paired tool card", () => {
    const items = buildTranscriptItems(hydrateThreadState(FULL_STATE).messages)
    expect(items.map((item) => item.kind)).toEqual(["user", "toolCall", "assistant"])
    expect(items[1]).toMatchObject({
      kind: "toolCall",
      toolResult: { toolCallId: "call_readDoc_0_0" },
    })
  })
})
