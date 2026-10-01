import type { RunAgentInput } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { fromRunAgentInput } from "../src/inbound.js"

function baseInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "th-1",
    runId: "rn-1",
    messages: [],
    tools: [],
    context: [],
    ...overrides,
  } as RunAgentInput
}

describe("fromRunAgentInput", () => {
  test("maps user and assistant messages to B4.run messages", () => {
    const input = baseInput({
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "hello" },
      ],
    } as Partial<RunAgentInput>)
    const result = fromRunAgentInput(input)
    expect(result.messages).toEqual([
      { role: "user", content: "hi", id: "m1" },
      { role: "assistant", content: "hello", id: "m2" },
    ])
    expect(result.resume).toBeUndefined()
    expect(result.raw).toBe(input)
  })

  test("maps a tool message, preserving toolCallId", () => {
    const input = baseInput({
      messages: [{ id: "m1", role: "tool", content: "42", toolCallId: "tc-9" }],
    } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).messages).toEqual([
      { role: "tool", content: "42", id: "m1", toolCallId: "tc-9" },
    ])
  })

  test("stringifies non-string, non-parts content", () => {
    const input = baseInput({
      messages: [{ id: "m1", role: "user", content: { text: "hi" } }],
    } as unknown as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).messages[0]?.content).toBe('{"text":"hi"}')
  })

  test("falls back to String() when JSON.stringify returns undefined", () => {
    const content = Symbol.for("x")
    const message = {
      id: "m1",
      role: "user",
      content,
    } as unknown as RunAgentInput["messages"][number]
    const input = baseInput({ messages: [message] })
    expect(fromRunAgentInput(input).messages[0]?.content).toBe(String(content))
  })

  test("maps a resume array to B4.run resume requests", () => {
    const input = baseInput({
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once" }],
    } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).resume).toEqual([
      { interruptId: "perm-1", status: "resolved", payload: "once" },
    ])
  })

  test("forwards every subagent permission decision without interpreting it", () => {
    const resume = [
      { interruptId: "perm-once", status: "resolved" as const, payload: "once" },
      { interruptId: "perm-always", status: "resolved" as const, payload: "always" },
      { interruptId: "perm-deny", status: "resolved" as const, payload: "deny" },
    ]
    const input = baseInput({ resume } as Partial<RunAgentInput>)

    expect(fromRunAgentInput(input).resume).toEqual(resume)
  })

  test("omits the resume property for an empty resume array", () => {
    const input = baseInput({ resume: [] } as Partial<RunAgentInput>)
    const result = fromRunAgentInput(input)
    expect(Object.hasOwn(result, "resume")).toBe(false)
    expect(result.resume).toBeUndefined()
  })

  test("drops activity and reasoning messages", () => {
    // Task 7: reasoning history is the client's artefact, not conversation.
    const input = baseInput({
      messages: [
        { id: "m1", role: "activity", content: { status: "running" }, activityType: "status" },
        { id: "m2", role: "reasoning", content: "thinking" },
      ],
    } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).messages).toEqual([])
  })

  test("raw preserves the original input for tools/state/context access", () => {
    const input = baseInput({ state: { a: 1 } } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).raw).toBe(input)
  })
})

describe("1.0 content", () => {
  const input = (messages: RunAgentInput["messages"]): RunAgentInput => ({
    threadId: "t",
    runId: "r",
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  })

  test("a user message's text parts concatenate in order", () => {
    const { messages } = fromRunAgentInput(
      input([
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "Hello, " },
            { type: "text", text: "world" },
          ],
        },
      ]),
    )
    expect(messages).toEqual([{ id: "1", role: "user", content: "Hello, world" }])
  })

  test("a tool message's text parts concatenate in order", () => {
    const { messages } = fromRunAgentInput(
      input([
        {
          id: "2",
          role: "tool",
          toolCallId: "c1",
          content: [
            { type: "text", text: '{"ok":' },
            { type: "text", text: "true}" },
          ],
        },
      ]),
    )
    expect(messages).toEqual([{ id: "2", role: "tool", toolCallId: "c1", content: '{"ok":true}' }])
  })

  test("reasoning and activity history is dropped, not re-spoken as the assistant", () => {
    const { messages } = fromRunAgentInput(
      input([
        { id: "3", role: "reasoning", content: "thinking…" },
        { id: "4", role: "activity", activityType: "b4.plan", content: { todos: [] } },
        { id: "5", role: "assistant", content: "done" },
      ]),
    )
    expect(messages).toEqual([{ id: "5", role: "assistant", content: "done" }])
  })

  test("an unvalidated part list with non-object entries does not throw", () => {
    const { messages } = fromRunAgentInput(
      input([
        {
          id: "6",
          role: "user",
          content: [
            { type: "text", text: "a" },
            null,
            "stray",
            { type: "text", text: "b" },
          ] as never,
        },
      ]),
    )
    expect(messages).toEqual([{ id: "6", role: "user", content: "ab" }])
  })
})
