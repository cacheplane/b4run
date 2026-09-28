import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

/**
 * Approval grants through a REAL agent route: a model turn calls an
 * approve-gated tool, the permission gate parks it on the checkpointer, and the
 * grant minted at that park answers the resume exactly once.
 *
 * `approval-grants-endpoint.test.ts` seeds grant rows against a stub graph and
 * a canned pending write, and the park-site test in `@b4run/core` drives a bare
 * compiled graph. Neither goes through an `agent()` route, so neither shows
 * that the minter the adapter injects into `config.configurable` is still the
 * one the permission gate reads when the tool runs inside the agent loop. This
 * does, end to end.
 */

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const PARK_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  '  tools: { approve: ["deployProd"] },',
  "})",
  "",
].join("\n")

/** Appends one line per execution, so a replayed resume that ran it twice shows. */
const DEPLOY_TOOL = [
  'import { appendFile } from "node:fs/promises"',
  "/** Deploy to an environment. */",
  "export default async function deployProd(input: { env: string }): Promise<string> {",
  "  await appendFile(process.env.B4_GRANT_TEST_LEDGER as string, input.env + '\\n')",
  "  return 'deployed to ' + input.env",
  "}",
  "",
].join("\n")

async function fixtureApp(
  mode: "required" | "optional",
): Promise<{ appRoot: string; ledger: string }> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-grant-agent-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": `export default { approvals: { grants: ${JSON.stringify(mode)} } }\n`,
    "package.json": '{ "name": "grant-agent-fixture", "type": "module" }\n',
    "src/app/park/index.ts": PARK_ROUTE,
    "src/app/park/tools/deployProd.ts": DEPLOY_TOOL,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  const ledger = join(appRoot, "deploys.log")
  await writeFile(ledger, "", "utf8")
  const previous = process.env.B4_GRANT_TEST_LEDGER
  process.env.B4_GRANT_TEST_LEDGER = ledger
  cleanup.push(() => {
    if (previous === undefined) delete process.env.B4_GRANT_TEST_LEDGER
    else process.env.B4_GRANT_TEST_LEDGER = previous
  })
  return { appRoot, ledger }
}

async function withAimock(): Promise<void> {
  const aimock = await createAimock({
    fixtures: script()
      .user("deploy to staging")
      .callsTool("deployProd", { env: "staging" })
      .replies("Deployed to staging.")
      .build(),
  })
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(async () => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
    await aimock.close()
  })
}

async function createHandler(appRoot: string) {
  const handler = await createRuntimeFetchHandler({
    appRoot,
    apSseHeartbeatIntervalMs: 60_000,
    drainDeadlineMs: 250,
  })
  cleanup.push(() => handler.close())
  return handler
}

type Handler = Awaited<ReturnType<typeof createHandler>>

async function park(handler: Handler, threadId: string): Promise<void> {
  const response = await handler.fetch(
    new Request(`http://localhost/threads/${threadId}/runs/stream`, {
      body: JSON.stringify({
        input: { messages: [{ content: "deploy to staging", role: "user" }] },
        route: "/park#agent",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("event: interrupt")
}

async function pending(
  handler: Handler,
  threadId: string,
): Promise<ReadonlyArray<{ interruptId: string; grant?: string }>> {
  const response = await handler.fetch(
    new Request(`http://localhost/threads/${threadId}/pending_interrupts`),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { interrupts: Array<{ interruptId: string; grant?: string }> })
    .interrupts
}

async function resume(
  handler: Handler,
  threadId: string,
  entry: Record<string, unknown>,
): Promise<Response> {
  return handler.fetch(
    new Request(`http://localhost/threads/${threadId}/resume`, {
      body: JSON.stringify({ resume: [entry], route: "/park#agent" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  )
}

async function deploys(ledger: string): Promise<string[]> {
  return (await readFile(ledger, "utf8")).split("\n").filter(Boolean)
}

async function codeOf(response: Response): Promise<unknown> {
  return ((await response.json()) as { error?: { details?: { code?: unknown } } }).error?.details
    ?.code
}

describe("approval grants through an agent route", () => {
  it("mints a grant at the permission park, and it answers the resume exactly once", async () => {
    await withAimock()
    const { appRoot, ledger } = await fixtureApp("required")
    const handler = await createHandler(appRoot)
    const threadId = "t-grant-agent-once"

    await park(handler, threadId)
    const [parked] = await pending(handler, threadId)
    expect(parked?.interruptId).toMatch(/^perm-/)
    expect(typeof parked?.grant).toBe("string")
    expect(parked?.grant?.length ?? 0).toBeGreaterThan(20)
    expect(await deploys(ledger)).toEqual([])

    const entry = {
      interruptId: parked?.interruptId,
      status: "resolved",
      payload: "once",
      grant: parked?.grant,
    }
    const first = await resume(handler, threadId, entry)
    expect(first.status).toBe(200)
    await first.text()
    expect(await deploys(ledger)).toEqual(["staging"])

    const replay = await resume(handler, threadId, entry)
    expect(replay.status).toBe(409)
    // The first resume finished the turn, so the interrupt is no longer
    // pending and `resolvePendingResume` refuses the replay before the grant is
    // even read. `grant_consumed` is the answer only while the interrupt is
    // still pending — a concurrent resume, covered by the store race tests.
    expect(await codeOf(replay)).toBe("stale_interrupt")
    expect(await deploys(ledger)).toEqual(["staging"])
  }, 60_000)

  it("refuses a resume that omits the grant under required, and runs nothing", async () => {
    await withAimock()
    const { appRoot, ledger } = await fixtureApp("required")
    const handler = await createHandler(appRoot)
    const threadId = "t-grant-agent-missing"

    await park(handler, threadId)
    const [parked] = await pending(handler, threadId)

    const response = await resume(handler, threadId, {
      interruptId: parked?.interruptId,
      status: "resolved",
      payload: "once",
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await codeOf(response)).toBe("grant_required")
    expect(await deploys(ledger)).toEqual([])
  }, 60_000)
})
