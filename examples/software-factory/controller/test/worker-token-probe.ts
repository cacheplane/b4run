import { expect } from "vitest"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

/** What a served worker's own requests carry: the one credential its policy admits. */
export const WORKER_AUTHORIZATION = { authorization: `Bearer ${TEST_WORKER_TOKEN}` } as const

/**
 * Every thread endpoint a worker serves, against a thread that exists: each must refuse a
 * caller that does not present exactly `Bearer <FACTORY_WORKER_TOKEN>`, with 403, and never
 * echo the token. Health stays open. Afterwards the thread is still there, so the refused
 * `DELETE` did nothing.
 */
export async function expectOnlyTheTokenAdmitted(
  url: string,
  threadId: string,
  route: string,
): Promise<void> {
  const thread = `${url}/threads/${encodeURIComponent(threadId)}`
  const turn = JSON.stringify({ route, input: { messages: [{ role: "user", content: "hi" }] } })
  const endpoints: ReadonlyArray<readonly [string, string, string?]> = [
    ["POST", `${url}/threads`, JSON.stringify({ metadata: {} })],
    ["GET", thread],
    ["GET", `${thread}/state`],
    ["GET", `${thread}/pending_interrupts`],
    ["GET", `${thread}/runs/stream`],
    ["POST", `${thread}/runs/stream`, turn],
    ["POST", `${thread}/runs/wait`, turn],
    ["POST", `${thread}/resume`, JSON.stringify({ route, resume: [] })],
    ["POST", `${thread}/cancel`],
    ["DELETE", thread],
    [
      "POST",
      `${url}/agui/${encodeURIComponent(route)}`,
      JSON.stringify({
        threadId,
        runId: "run-1",
        messages: [{ id: "m-1", role: "user", content: "hi" }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    ],
  ]
  const wrong: ReadonlyArray<Record<string, string>> = [
    {},
    { authorization: "" },
    { authorization: TEST_WORKER_TOKEN },
    { authorization: `bearer ${TEST_WORKER_TOKEN}` },
    { authorization: `Bearer ${TEST_WORKER_TOKEN}x` },
    { authorization: `Bearer ${TEST_WORKER_TOKEN.slice(0, -1)}` },
    { authorization: `Bearer ${"x".repeat(TEST_WORKER_TOKEN.length)}` },
  ]
  const answers: string[] = []
  for (const [method, target, body] of endpoints)
    for (const headers of wrong) {
      const response = await fetch(target, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body !== undefined ? { body } : {}),
      })
      const text = await response.text()
      expect(text).not.toContain(TEST_WORKER_TOKEN)
      answers.push(`${method} ${new URL(target).pathname} ${response.status}`)
    }
  expect(answers.filter((answer) => !answer.endsWith(" 403"))).toEqual([])
  expect((await fetch(`${url}/healthz`)).status).toBe(200)
  const still = await fetch(thread, { headers: WORKER_AUTHORIZATION })
  expect(still.status).toBe(200)
}
