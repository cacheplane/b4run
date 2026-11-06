import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"

import {
  fromAspMessageRole,
  mergePublicMessages,
  parsePublicMessages,
  toAspMessageRole,
  toPublicMessage,
} from "../src/lib/dev/protocol/messages.ts"

const blocks = [
  { type: "text", text: "answer", annotations: [{ kind: "citation", source: "local" }] },
  { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
  { type: "audio", data: "opaque", mimeType: "audio/wav" },
  { type: "reasoning", text: "summary", signature: "signed" },
  { type: "provider.future", payload: { lc: "opaque native block", kwargs: { x: 1 } } },
]

describe("public protocol messages", () => {
  it.each(["user", "assistant", "system", "tool"] as const)(
    "preserves public %s roles, IDs, blocks and annotations",
    (role) => {
      const message = {
        role,
        id: "stable-id",
        content: blocks,
        metadata: { answer: true },
        provider: { signature: "opaque" },
      }
      expect(parsePublicMessages([message])).toEqual([message])
      expect(toPublicMessage(message)).toEqual(message)
    },
  )

  it.each([
    [new HumanMessage({ id: "human", content: "hello" }), "user", "human"],
    [
      new AIMessage({ id: "ai", content: blocks, response_metadata: { provider: "fixture" } }),
      "assistant",
      "ai",
    ],
    [new SystemMessage({ id: "sys", content: "rules" }), "system", "sys"],
    [new ToolMessage({ id: "tool", content: "result", tool_call_id: "call-1" }), "tool", "tool"],
  ] as const)("projects native message %s without serialization internals", (message, role, id) => {
    const result = toPublicMessage(message)
    expect(result).toMatchObject({ role, id, content: message.content })
    expect(result).not.toHaveProperty("lc")
    expect(result).not.toHaveProperty("lc_kwargs")
    expect(result).not.toHaveProperty("kwargs")
    expect(result).not.toHaveProperty("lc_serializable")
    expect(toPublicMessage(JSON.parse(JSON.stringify(message)))).toEqual(result)
  })

  it("preserves tool-call and provider facts in native envelopes", () => {
    const message = new AIMessage({
      id: "reply",
      content: blocks,
      tool_calls: [{ id: "call-1", name: "read", args: { path: "a" }, type: "tool_call" }],
      additional_kwargs: { provider: { answer: true } },
      response_metadata: { model: "fixture" },
    })
    expect(toPublicMessage(message)).toMatchObject({
      id: "reply",
      content: blocks,
      tool_calls: message.tool_calls,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    })
    expect(
      toPublicMessage(new ToolMessage({ content: "done", tool_call_id: "call-1" })),
    ).toMatchObject({ role: "tool", tool_call_id: "call-1" })
  })

  it.each([
    ["human", "user"],
    ["ai", "assistant"],
    ["system", "system"],
  ] as const)("maps ASP %s explicitly", (asp, rest) => {
    expect(fromAspMessageRole(asp)).toBe(rest)
    expect(toAspMessageRole(rest)).toBe(asp)
  })

  it("keeps tool facts off the ASP messages channel", () => {
    expect(() => toAspMessageRole("tool")).toThrow(/tools channel/)
    expect(() => fromAspMessageRole("assistant")).toThrow(/role/)
  })

  it.each([
    [{ role: "human", content: "wrong dialect" }],
    [{ role: "assistant", id: 1, content: "wrong id" }],
    [{ role: "user", content: ["not a block"] }],
    [{ role: "assistant", content: [{ text: "missing type" }] }],
    [{ role: "user", content: [], lc: 1, id: ["internal"], kwargs: {} }],
    "not an array",
  ])("rejects invalid public message input %#", (messages) => {
    expect(() => parsePublicMessages(messages)).toThrow(/message/i)
  })

  it("keeps first appearance order and deduplicates identical IDs independent of object key order", () => {
    const first = { id: "a", role: "user" as const, content: "a", metadata: { x: 1, y: 2 } }
    expect(
      mergePublicMessages(
        [first],
        [
          { content: "a", role: "user", id: "a", metadata: { y: 2, x: 1 } },
          { role: "assistant", id: "b", content: "b" },
        ],
      ),
    ).toEqual([first, { role: "assistant", id: "b", content: "b" }])
  })

  it("rejects conflicting duplicate IDs including within one source", () => {
    const a = { id: "same", role: "user" as const, content: "a" }
    const b = { ...a, content: "b" }
    expect(() => mergePublicMessages([a], [b])).toThrow(/conflicting.*same/i)
    expect(() => parsePublicMessages([a, b])).toThrow(/conflicting.*same/i)
  })

  it("preserves messages without IDs without inventing unstable identity", () => {
    const message = { role: "user" as const, content: "repeat" }
    expect(mergePublicMessages([message], [message])).toEqual([message, message])
  })
})
