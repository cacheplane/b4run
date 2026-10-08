import { matchFixture } from "@copilotkit/aimock"
import { describe, expect, it } from "vitest"
import { type Recording, recordingsToFixtures } from "../src/record-fixtures.js"

function userReq(text: string): Recording["request"] {
  return { messages: [{ role: "user", content: text }] }
}
function toolRoundReq(userText: string): Recording["request"] {
  // Built as a standalone const so the extra OpenAI wire-shape fields
  // (tool_calls, tool_call_id) aren't rejected by excess-property checks
  // against Recording's minimal structural message type.
  const messages = [
    { role: "user", content: userText },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_x",
          type: "function",
          function: { name: "greet", arguments: "{}" },
        },
      ],
    },
    { role: "tool", content: "ok", tool_call_id: "call_x" },
  ]
  return { messages }
}

describe("recordingsToFixtures", () => {
  it("maps a text-only single call to one fixture (turn 0, no tool result)", () => {
    const recordings: Recording[] = [
      { request: userReq("hello"), response: { content: "Hi there" } },
    ]
    expect(recordingsToFixtures(recordings)).toEqual([
      {
        match: { userMessage: "hello", turnIndex: 0, hasToolResult: false },
        response: { content: "Hi there" },
      },
    ])
  })

  it("maps a tool round (2 calls) to turn 0 toolCall + turn 1 reply with hasToolResult", () => {
    const recordings: Recording[] = [
      {
        request: userReq("greet me"),
        response: {
          toolCalls: [{ id: "call_x", name: "greet", arguments: { who: "me" } }],
        },
      },
      { request: toolRoundReq("greet me"), response: { content: "Hello, me" } },
    ]
    expect(recordingsToFixtures(recordings)).toEqual([
      {
        match: { userMessage: "greet me", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [{ id: "call_x", name: "greet", arguments: { who: "me" } }],
        },
      },
      {
        match: { userMessage: "greet me", turnIndex: 1, hasToolResult: true },
        response: { content: "Hello, me" },
      },
    ])
  })

  it("keys on the user message the tool round answers, past the assistant and tool messages", () => {
    const recordings: Recording[] = [
      {
        request: toolRoundReq("original prompt"),
        response: { content: "done" },
      },
    ]
    const [fx] = recordingsToFixtures(recordings)
    expect(fx?.match.userMessage).toBe("original prompt")
  })

  it("keys a later turn of a conversation on its LAST user message, the one aimock matches", () => {
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow-up" },
    ]
    const [fx] = recordingsToFixtures([{ request: { messages }, response: { content: "more" } }])
    expect(fx?.match).toEqual({ userMessage: "follow-up", turnIndex: 1, hasToolResult: false })
  })

  it("rejects at record time a recording replay would reject, naming the turn", () => {
    const recordings: Recording[] = [
      {
        request: userReq("show me the ledger"),
        response: {
          toolCalls: [{ id: "call_r", name: "render", arguments: { ui: [] } }],
        },
      },
      {
        request: toolRoundReq("show me the ledger"),
        response: { content: "" },
      },
    ]
    expect(() => recordingsToFixtures(recordings)).toThrow(
      /turn 1 of "show me the ledger": content is empty string/,
    )
  })

  it("names the likely causes and returnDirect in the record-time error", () => {
    const recordings: Recording[] = [{ request: userReq("q"), response: { content: "" } }]
    expect(() => recordingsToFixtures(recordings)).toThrow(/refus/)
    expect(() => recordingsToFixtures(recordings)).toThrow(/returnDirect/)
  })

  it("reports every rejected turn, not just the first", () => {
    const recordings: Recording[] = [
      { request: userReq("q"), response: { content: "" } },
      { request: toolRoundReq("q"), response: { content: "" } },
    ]
    expect(() => recordingsToFixtures(recordings)).toThrow(/turn 0 of "q"[\s\S]*turn 1 of "q"/)
  })
})

describe("recordingsToFixtures with multimodal requests", () => {
  it("keys a recorded turn on the text of its parts", () => {
    const [fixture] = recordingsToFixtures([
      {
        request: {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe this" },
                { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              ],
            },
          ],
        },
        response: { content: "a cat" },
      },
    ])
    expect(fixture?.match.userMessage).toBe("describe this")
  })

  it("skips a user message with no text and keys on the next one that has some", () => {
    const [fixture] = recordingsToFixtures([
      {
        request: {
          messages: [
            { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] },
            { role: "user", content: "now this" },
          ],
        },
        response: { content: "ok" },
      },
    ])
    expect(fixture?.match.userMessage).toBe("now this")
  })

  it("keys on the text message when the SDK splits text and image into separate user messages", () => {
    const [fixture] = recordingsToFixtures([
      {
        request: {
          messages: [
            { role: "user", content: [{ type: "text", text: "describe this" }] },
            { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] },
          ],
        },
        response: { content: "ok" },
      },
    ])
    expect(fixture?.match.userMessage).toBe("describe this")
  })
})

describe("recordingsToFixtures with subagents dispatched in parallel (#937)", () => {
  type Message = NonNullable<Recording["request"]["messages"]>[number]
  const tools = (...names: string[]) => names.map((name) => ({ function: { name } }))
  const system = (text: string) => ({ role: "system", content: text })
  // The parent's message is a substring of each child's input, as it is when a
  // parent passes the user's request on; aimock matches `userMessage` as a substring.
  const parent = (...rest: Message[]) => ({
    messages: [system("dispatcher"), { role: "user", content: "plan the trip" }, ...rest],
    tools: tools("task"),
  })
  const child = (name: string, ...rest: Message[]) => ({
    messages: [system(name), { role: "user", content: `${name}: plan the trip` }, ...rest],
    tools: tools(`lookup_${name}`),
  })
  const call = (id: string, name: string) => ({
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  })
  const result = (id: string) => ({ role: "tool", content: "ok", tool_call_id: id })

  // Recorded in completion order: beta finishes before alpha, both before the parent's reply.
  const recordings: Recording[] = [
    {
      request: parent(),
      response: {
        toolCalls: [
          { id: "t_a", name: "task", arguments: { subagent: "alpha" } },
          { id: "t_b", name: "task", arguments: { subagent: "beta" } },
        ],
      },
    },
    {
      request: child("beta"),
      response: { toolCalls: [{ id: "b1", name: "lookup_beta", arguments: {} }] },
    },
    {
      request: child("alpha"),
      response: { toolCalls: [{ id: "a1", name: "lookup_alpha", arguments: {} }] },
    },
    { request: child("beta", call("b1", "lookup_beta"), result("b1")), response: { content: "B" } },
    {
      request: child("alpha", call("a1", "lookup_alpha"), result("a1")),
      response: { content: "A" },
    },
    {
      request: parent(call("t_a", "task"), result("t_a"), result("t_b")),
      response: { content: "done" },
    },
  ]

  it("keys each turn on its own run, whatever order the runs interleaved in", () => {
    expect(
      recordingsToFixtures(recordings).map((f) => [
        f.match.userMessage,
        f.match.turnIndex,
        f.match.hasToolResult,
      ]),
    ).toEqual([
      ["plan the trip", 0, false],
      ["beta: plan the trip", 0, false],
      ["alpha: plan the trip", 0, false],
      ["beta: plan the trip", 1, true],
      ["alpha: plan the trip", 1, true],
      ["plan the trip", 1, true],
    ])
  })

  it("narrows a parent turn whose message a child's input contains, so replay serves each its own", () => {
    const fixtures = recordingsToFixtures(recordings)
    // The parent's first turn, recorded ahead of its children's, would otherwise also
    // answer their first requests. Its reply is recorded after theirs, so it needs nothing.
    expect(fixtures[0]?.match.toolName).toBe("task")
    expect(fixtures.slice(1).map((f) => f.match.toolName)).toEqual(Array(5).fill(undefined))
    for (const [i, recording] of recordings.entries()) {
      const served = matchFixture(
        fixtures as never,
        {
          model: "replay",
          messages: recording.request.messages,
          tools: recording.request.tools,
        } as never,
      )
      expect(served?.response).toEqual(recording.response)
      expect(served).toBe(fixtures[i])
    }
  })

  it("refuses a recording whose different requests nothing can tell apart", () => {
    const same = { messages: [{ role: "user", content: "plan the trip" }] }
    const longer = { messages: [{ role: "user", content: "alpha: plan the trip" }] }
    expect(() =>
      recordingsToFixtures([
        { request: same, response: { content: "parent" } },
        { request: longer, response: { content: "child" } },
      ]),
    ).toThrow(
      /would not replay deterministically[\s\S]*turn 0 of "alpha: plan the trip" would be answered with the response recorded for turn 0 of "plan the trip"/,
    )
  })

  it("accepts identical requests that recorded different responses: replay serves the first", () => {
    const fixtures = recordingsToFixtures([
      { request: userReq("again"), response: { content: "one" } },
      { request: userReq("again"), response: { content: "two" } },
    ])
    expect(fixtures).toHaveLength(2)
  })
})
