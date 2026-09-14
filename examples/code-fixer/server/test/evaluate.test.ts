import type { AgentRunResult } from "@b4run/testing"
import { expect, it } from "vitest"
import { behaviorCriteria } from "../src/blueprint/evaluate.ts"

const run = {
  toolCalls: [
    { name: "runBash", args: { command: "npm test" } },
    { name: "writeFile", args: { path: "src/cli.ts", content: "repair" } },
    { name: "runBash", args: { command: "npm test" } },
  ],
  toolResults: [
    { name: "runBash", content: { exitCode: 1 }, isError: false },
    { name: "writeFile", content: "ok", isError: false },
    { name: "runBash", content: JSON.stringify({ exitCode: 0 }), isError: false },
  ],
  interrupts: [{ kind: "tool", detail: { toolName: "exportForReview" } }],
} as unknown as AgentRunResult
it("requires observed failing tests before edits and passing tests after", () => {
  expect(behaviorCriteria(run)).toEqual({ reproduced: true, verified: true, approval: true })
  expect(behaviorCriteria({ ...run, toolResults: [] }).reproduced).toBe(false)
  expect(behaviorCriteria({ ...run, toolCalls: run.toolCalls.slice(1) }).reproduced).toBe(false)
})
it("rejects final-answer-only success and unrelated permission pauses", () => {
  expect(behaviorCriteria({ ...run, toolCalls: [], toolResults: [], interrupts: [] })).toEqual({
    reproduced: false,
    verified: false,
    approval: false,
  })
})
