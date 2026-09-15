import type { AgentRunResult } from "@b4run/testing"
import { expect, it } from "vitest"
import { behaviorCriteria } from "../src/app/fix/evals/scoring.ts"
import { candidateDigest } from "../src/review/candidate.ts"

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
it.each(["npm test --silent", "npm --silent test", "npm run test", "npm run test --silent"])(
  "scores the equivalent test command %s",
  (command) => {
    const equivalent = {
      ...run,
      toolCalls: run.toolCalls.map((call) =>
        call.name === "runBash" ? { ...call, args: { command } } : call,
      ),
    }
    expect(behaviorCriteria(equivalent)).toEqual({
      reproduced: true,
      verified: true,
      approval: true,
    })
  },
)
it.each([
  "npm test || true",
  "npm test -- --test-name-pattern=missing",
  "npm test; echo ok",
  "npm\ntest",
])("rejects weakened or compound test commands %s", (command) => {
  const changed = {
    ...run,
    toolCalls: run.toolCalls.map((call) =>
      call.name === "runBash" ? { ...call, args: { command } } : call,
    ),
  }
  expect(behaviorCriteria(changed).reproduced).toBe(false)
  expect(behaviorCriteria(changed).verified).toBe(false)
})

const candidateContent = {
  version: 1 as const,
  workspaceId: "workspace",
  sourceDigest: "source",
  changes: { "src/cli.ts": "repaired" },
}
const candidate = { ...candidateContent, receiptDigest: candidateDigest(candidateContent) }
function preparedRun(preparedCandidate: unknown, exportCandidate: unknown) {
  return {
    ...run,
    toolCalls: [
      ...run.toolCalls,
      { name: "exportForReview", args: { candidate: exportCandidate } },
    ],
    toolResults: [
      ...run.toolResults,
      {
        name: "prepareReview",
        content: {
          verification: { visible: { passed: true }, independent: { passed: true } },
          candidate: preparedCandidate,
        },
        isError: false,
      },
    ],
  } as AgentRunResult
}
it("requires verified nonempty source and approval of the exact prepared candidate", async () => {
  const { repairCriteria } = await import("../src/app/fix/evals/scoring.ts")
  expect(repairCriteria(run)).toMatchObject({
    visible: false,
    independent: false,
    scope: false,
    approval: false,
  })
  expect(repairCriteria(preparedRun(candidate, candidate))).toEqual({
    reproduced: true,
    verified: true,
    approval: true,
    visible: true,
    independent: true,
    scope: true,
  })
})
it("rejects a different, malformed, or tampered approval candidate", async () => {
  const { repairCriteria } = await import("../src/app/fix/evals/scoring.ts")
  const otherContent = { ...candidateContent, changes: { "src/cli.ts": "different repair" } }
  for (const pending of [
    { ...otherContent, receiptDigest: candidateDigest(otherContent) },
    { ...otherContent, receiptDigest: candidate.receiptDigest },
    {},
    undefined,
  ])
    expect(repairCriteria(preparedRun(candidate, pending)).approval).toBe(false)
  expect(repairCriteria(preparedRun({}, candidate)).approval).toBe(false)
})
