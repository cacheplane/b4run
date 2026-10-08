import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, it } from "vitest"
import { type Aimock, createAimock } from "../src/aimock-runner.js"
import type { AimockFixture, FixtureSet } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const route = "/parallel-chat#agent"

// The parent's message is a substring of each subagent's input, as it is when a
// parent passes the user's request on, and aimock matches `userMessage` as a substring.
const INPUT = "plan the trip"
const ALPHA = `alpha: ${INPUT}`
const BETA = `beta: ${INPUT}`

// The upstream the recording proxies to. The parent dispatches both subagents in
// one turn, so they run concurrently; alpha's first answer is slow, so beta's
// turns complete (and are recorded) first, out of dispatch order.
const upstreamFixtures = [
  {
    match: { userMessage: ALPHA, turnIndex: 0, hasToolResult: false },
    response: { toolCalls: [{ id: "call_alpha", name: "lookupAlpha", arguments: { query: "a" } }] },
    latency: 400,
  },
  {
    match: { userMessage: ALPHA, turnIndex: 1, hasToolResult: true },
    response: { content: "ALPHA DONE" },
  },
  {
    match: { userMessage: BETA, turnIndex: 0, hasToolResult: false },
    response: { toolCalls: [{ id: "call_beta", name: "lookupBeta", arguments: { query: "b" } }] },
  },
  {
    match: { userMessage: BETA, turnIndex: 1, hasToolResult: true },
    response: { content: "BETA DONE" },
  },
  {
    match: { userMessage: INPUT, turnIndex: 0, hasToolResult: false, toolName: "task" },
    response: {
      toolCalls: [
        { id: "call_task_alpha", name: "task", arguments: { subagent: "alpha", input: ALPHA } },
        { id: "call_task_beta", name: "task", arguments: { subagent: "beta", input: BETA } },
      ],
    },
  },
  {
    match: { userMessage: INPUT, turnIndex: 1, hasToolResult: true, toolName: "task" },
    response: { content: "Both halves done." },
  },
] as unknown as AimockFixture[]

let upstream: Aimock
let recorded: FixtureSet
let recordedRun: Awaited<ReturnType<Awaited<ReturnType<typeof createAgentHarness>>["run"]>>

beforeAll(async () => {
  // Record mode does not inject a dummy key; the local upstream ignores auth.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-record-placeholder"
  upstream = await createAimock({ fixtures: upstreamFixtures })
  const recorder = await createAgentHarness({
    appRoot,
    route,
    record: true,
    recordUpstream: upstream.baseUrl.replace(/\/v1$/, ""),
  })
  try {
    recordedRun = await recorder.run({ input: INPUT })
    recorded = recorder.getRecordedFixtures()
  } finally {
    await recorder.close()
  }
}, 60_000)

afterAll(async () => {
  await upstream?.close()
})

/** What a run did, in a form that does not depend on the order concurrent tools finished in. */
function outcome(run: typeof recordedRun) {
  return {
    finalMessage: run.finalMessage,
    toolResults: run.toolResults
      .map((entry) => `${entry.name}: ${JSON.stringify(entry.content)}`)
      .sort(),
  }
}

it("records the parent and both concurrent subagents, each keyed on its own run", () => {
  expect(recordedRun.finalMessage).toContain("Both halves done.")
  // Every call went upstream: none was answered from an earlier call's recording.
  expect(upstream.getRequests()).toHaveLength(6)
  const keys = recorded.map((fixture) => [
    fixture.match.userMessage,
    fixture.match.turnIndex,
    fixture.match.hasToolResult,
  ])
  // Six model calls, each filed under the run that made it at its position in that run.
  expect(keys).toHaveLength(6)
  expect(keys).toEqual(
    expect.arrayContaining([
      [INPUT, 0, false],
      [INPUT, 1, true],
      [ALPHA, 0, false],
      [ALPHA, 1, true],
      [BETA, 0, false],
      [BETA, 1, true],
    ]),
  )
  const responseFor = (userMessage: string, turnIndex: number) =>
    recorded.find(
      (fixture) =>
        fixture.match.userMessage === userMessage && fixture.match.turnIndex === turnIndex,
    )?.response
  expect(responseFor(ALPHA, 1)).toMatchObject({ content: "ALPHA DONE" })
  expect(responseFor(BETA, 1)).toMatchObject({ content: "BETA DONE" })
  expect(responseFor(INPUT, 1)).toMatchObject({ content: "Both halves done." })
  expect(JSON.stringify(responseFor(ALPHA, 0))).toContain("lookupAlpha")
  expect(JSON.stringify(responseFor(BETA, 0))).toContain("lookupBeta")
})

it("replays the recording deterministically, run after run", async () => {
  const expected = outcome(recordedRun)
  // Each `task` result is that subagent's own closing reply.
  expect(expected.toolResults).toEqual(['task: "ALPHA DONE"', 'task: "BETA DONE"'])
  const replay = await createAgentHarness({ appRoot, route, fixtures: recorded })
  try {
    for (let i = 0; i < 3; i++) {
      replay.reset()
      expect(outcome(await replay.run({ input: INPUT }))).toEqual(expected)
    }
  } finally {
    await replay.close()
  }
}, 60_000)
