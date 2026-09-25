import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"
import { type Aimock, createAimock } from "../src/aimock-runner.js"
import { type AgentHarness, createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

const schema = {
  type: "object",
  properties: { ui: { type: "array", items: { type: "string" } } },
  required: ["ui"],
  additionalProperties: false,
}

const open: Array<AgentHarness | Aimock> = []
afterEach(async () => {
  for (const handle of open.splice(0).reverse()) await handle.close()
})

/** Record against a local upstream so the exact request the model received is observable. */
async function recordAgainstUpstream(responseSchema?: Readonly<Record<string, unknown>>) {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-record-placeholder"
  const upstream = await createAimock({
    fixtures: [{ match: {}, response: { content: '{"ui":["Table"]}' } }],
  })
  open.push(upstream)
  const harness = await createAgentHarness({
    appRoot,
    route: "/chat#agent",
    record: true,
    recordUpstream: upstream.baseUrl.replace(/\/v1$/, ""),
    ...(responseSchema !== undefined ? { responseSchema } : {}),
  })
  open.push(harness)
  const run = await harness.run({ input: "show me the ledger" })
  const bodies = upstream.getRequests().map((r) => r.body as Record<string, unknown> | null)
  return { run, bodies }
}

it("binds responseSchema on the model request exactly as an AG-UI run does", async () => {
  const { run, bodies } = await recordAgainstUpstream(schema)
  expect(run.finalMessage).toBe('{"ui":["Table"]}')
  expect(bodies.length).toBeGreaterThan(0)
  for (const body of bodies) {
    expect(body?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "hashbrown_response", schema, strict: true },
    })
  }
})

it("sends no response_format when no responseSchema is given", async () => {
  const { bodies } = await recordAgainstUpstream()
  expect(bodies.length).toBeGreaterThan(0)
  for (const body of bodies) expect(body).not.toHaveProperty("response_format")
})

it("rejects a responseSchema that is not a JSON Schema object", async () => {
  await expect(
    createAgentHarness({
      appRoot,
      route: "/chat#agent",
      responseSchema: ["not", "a", "schema"] as unknown as Record<string, unknown>,
    }),
  ).rejects.toThrow("createAgentHarness: `responseSchema` must be a JSON Schema object")
})
