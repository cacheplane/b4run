import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  isToolMessage,
  ToolMessage,
} from "@langchain/core/messages"
import { expect, test } from "vitest"
import { answerDanglingToolCalls } from "../src/agent-middleware.ts"

const calls = (...ids: string[]) =>
  new AIMessage({
    content: "",
    tool_calls: ids.map((id) => ({ id, name: "lookup", args: {}, type: "tool_call" as const })),
  })
const result = (id: string) =>
  new ToolMessage({ content: "{}", name: "lookup", tool_call_id: id, status: "success" })
const shape = (messages: readonly BaseMessage[]) =>
  messages.map((m) => (isToolMessage(m) ? `tool:${m.tool_call_id}:${m.status}` : `${m.getType()}`))

test("a history whose tool calls all have results is returned as the same array", () => {
  const messages = [new HumanMessage("q"), calls("a"), result("a"), new AIMessage("done")]

  const repaired = answerDanglingToolCalls(messages)

  expect(repaired).toBe(messages)
})

test("an unanswered call gets an error result right after its assistant message", () => {
  const messages = [new HumanMessage("q"), calls("a"), new HumanMessage("and now?")]

  const repaired = answerDanglingToolCalls(messages)

  expect(shape(repaired)).toEqual(["human", "ai", "tool:a:error", "human"])
  expect(shape(messages)).toEqual(["human", "ai", "human"])
})

test("of parallel calls, only the unanswered one is filled, after the recorded results", () => {
  const messages = [new HumanMessage("q"), calls("a", "b"), result("a"), new HumanMessage("next")]

  const repaired = answerDanglingToolCalls(messages)

  expect(shape(repaired)).toEqual(["human", "ai", "tool:a:success", "tool:b:error", "human"])
})

test("an unanswered call as the last message is filled at the end", () => {
  const messages = [new HumanMessage("q"), calls("a")]

  const repaired = answerDanglingToolCalls(messages)

  expect(shape(repaired)).toEqual(["human", "ai", "tool:a:error"])
})
