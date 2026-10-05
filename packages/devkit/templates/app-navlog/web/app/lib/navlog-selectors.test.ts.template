import { describe, expect, test } from "vitest"
import { lastAssistantText, latestNavlog, parseNavlog } from "./navlog-selectors"
import { SAMPLE_NAVLOG } from "./navlog-types"

const toolCall = (id: string, name: string) => ({
  id: `m-${id}`,
  role: "assistant" as const,
  content: "",
  toolCalls: [{ id, type: "function" as const, function: { name, arguments: "{}" } }],
})
const toolResult = (id: string, content: string) => ({
  id: `r-${id}`,
  role: "tool" as const,
  toolCallId: id,
  content,
})

describe("parseNavlog", () => {
  test("accepts the server's Navlog JSON", () => {
    expect(parseNavlog(JSON.stringify(SAMPLE_NAVLOG))?.totals.distanceNm).toBe(66)
  })
  test("unwraps a { result } envelope and rejects anything else", () => {
    expect(parseNavlog(JSON.stringify({ result: SAMPLE_NAVLOG }))?.legs).toHaveLength(2)
    expect(parseNavlog("not json")).toBeNull()
    expect(parseNavlog(JSON.stringify({ legs: "nope" }))).toBeNull()
  })
})

describe("latestNavlog", () => {
  test("returns the most recent computeNavlog result in the thread", () => {
    const older = { ...SAMPLE_NAVLOG, totals: { ...SAMPLE_NAVLOG.totals, distanceNm: 1 } }
    const messages = [
      toolCall("c1", "computeNavlog"),
      toolResult("c1", JSON.stringify(older)),
      toolCall("c2", "readDoc"),
      toolResult("c2", '{"content":"x"}'),
      toolCall("c3", "computeNavlog"),
      toolResult("c3", JSON.stringify(SAMPLE_NAVLOG)),
    ]
    expect(latestNavlog(messages)?.totals.distanceNm).toBe(66)
  })
  test("reads a tool result delivered as an array of text content parts", () => {
    const json = JSON.stringify(SAMPLE_NAVLOG)
    const half = Math.floor(json.length / 2)
    const messages = [
      toolCall("c1", "computeNavlog"),
      {
        id: "r-c1",
        role: "tool" as const,
        toolCallId: "c1",
        content: [
          { type: "text", text: json.slice(0, half) },
          { type: "text", text: json.slice(half) },
        ],
      },
    ]
    expect(latestNavlog(messages)?.totals.distanceNm).toBe(66)
  })
  test("is null with no navlog, and ignores a call whose result has not arrived", () => {
    expect(latestNavlog([toolCall("c1", "computeNavlog")])).toBeNull()
    expect(latestNavlog([])).toBeNull()
  })
})

describe("lastAssistantText", () => {
  test("picks the last non-empty assistant message", () => {
    const messages = [
      { id: "a1", role: "assistant", content: "First plan." },
      { id: "u1", role: "user", content: "Again?" },
      { id: "a2", role: "assistant", content: [{ type: "text", text: "Second plan." }] },
      toolCall("c1", "computeNavlog"),
      toolResult("c1", JSON.stringify(SAMPLE_NAVLOG)),
    ]
    expect(lastAssistantText(messages)).toBe("Second plan.")
  })
  test("is empty when no assistant has spoken", () => {
    expect(lastAssistantText([{ id: "u1", role: "user", content: "hi" }])).toBe("")
    expect(lastAssistantText([])).toBe("")
  })
})
