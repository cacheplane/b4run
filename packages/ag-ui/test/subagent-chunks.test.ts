import { describe, expect, test } from "vitest"
import {
  asSubagentEndData,
  asSubagentStartData,
  unwrapSubagentChunk,
} from "../src/subagent-chunks.ts"

const ID = { call_id: "c1", subagent: "researcher", route_id: "/r#researcher", depth: 1 }

describe("unwrapSubagentChunk", () => {
  test("token and reasoning become string-payload chunks with the owner", () => {
    expect(
      unwrapSubagentChunk({ type: "subagent.token", data: { ...ID, data: "hi", messageId: "m1" } }),
    ).toEqual({ owner: "c1", chunk: { type: "token", data: "hi", messageId: "m1" } })
    expect(
      unwrapSubagentChunk({
        type: "subagent.reasoning",
        data: { ...ID, data: "think", messageId: "m1" },
      }),
    ).toEqual({ owner: "c1", chunk: { type: "reasoning", data: "think", messageId: "m1" } })
  })

  test("object payloads keep their keys and lose the identity", () => {
    expect(
      unwrapSubagentChunk({
        type: "subagent.tool_call",
        data: { ...ID, id: "t1", name: "search", input: { q: 1 } },
      }),
    ).toEqual({
      owner: "c1",
      chunk: { type: "tool_call", data: { id: "t1", name: "search", input: { q: 1 } } },
    })
    expect(
      unwrapSubagentChunk({ type: "subagent.message_end", data: { ...ID, messageId: "m1" } }),
    ).toEqual({ owner: "c1", chunk: { type: "message_end", data: { messageId: "m1" } } })
    expect(
      unwrapSubagentChunk({ type: "subagent.plan_update", data: { ...ID, todos: [] } }),
    ).toEqual({ owner: "c1", chunk: { type: "plan_update", data: { todos: [] } } })
  })

  test("lifecycle, usage, non-subagent and malformed chunks are not unwrapped", () => {
    expect(unwrapSubagentChunk({ type: "subagent.start", data: ID })).toBeNull()
    expect(unwrapSubagentChunk({ type: "subagent.end", data: ID })).toBeNull()
    expect(
      unwrapSubagentChunk({ type: "subagent.usage", data: { ...ID, usage_metadata: {} } }),
    ).toBeNull()
    expect(unwrapSubagentChunk({ type: "token", data: "root" })).toBeNull()
    expect(unwrapSubagentChunk({ type: "subagent.token", data: { data: "no id" } })).toBeNull()
    expect(unwrapSubagentChunk({ type: "subagent.token", data: { ...ID, call_id: "" } })).toBeNull()
  })
})

describe("start and end data", () => {
  test("start carries identity plus optional parent and description", () => {
    expect(asSubagentStartData({ ...ID, parent_call_id: "c0", description: "Finds" })).toEqual({
      callId: "c1",
      name: "researcher",
      depth: 1,
      parentCallId: "c0",
      description: "Finds",
    })
    expect(asSubagentStartData(ID)).toEqual({ callId: "c1", name: "researcher", depth: 1 })
    expect(asSubagentStartData({ ...ID, subagent: "" })).toBeNull()
    expect(asSubagentStartData({ ...ID, depth: 0 })).toBeNull()
  })

  test("end is success with a result, or an error", () => {
    expect(asSubagentEndData({ ...ID, final_message: "done" })).toEqual({
      callId: "c1",
      result: "done",
    })
    expect(asSubagentEndData({ ...ID, error: "boom" })).toEqual({ callId: "c1", error: "boom" })
    expect(asSubagentEndData({ ...ID })).toEqual({ callId: "c1" })
    expect(asSubagentEndData({ ...ID, final_message: 3 })).toBeNull()
  })
})
