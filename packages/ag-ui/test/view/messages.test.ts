import { describe, expect, test } from "vitest"
import { isSubagentMessage } from "../../src/view/messages.ts"

describe("isSubagentMessage", () => {
  test("narrows a transcript message tagged with a subagentRunId", () => {
    expect(
      isSubagentMessage({ id: "1", role: "assistant", content: "x", subagentRunId: "c1" }),
    ).toBe(true)
    expect(isSubagentMessage({ id: "2", role: "assistant", content: "y" })).toBe(false)
  })
})
