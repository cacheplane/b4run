import { AIMessage } from "@langchain/core/messages"
import { expect, it } from "vitest"
import { answerDanglingToolCalls } from "../src/agent-middleware.ts"

it("does not label an issued tool with a missing durable result as never executed", () => {
  const repaired = answerDanglingToolCalls([
    new AIMessage({
      content: "",
      tool_calls: [{ id: "issued-unknown", name: "effect", args: {} }],
    }),
  ])
  expect(repaired[1]?.content).not.toContain("did not run")
  expect(repaired[1]?.content).toContain("unknown")
})
