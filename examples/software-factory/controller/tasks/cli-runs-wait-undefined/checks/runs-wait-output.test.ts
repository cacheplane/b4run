import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"

// The reference test of b090ad42 (`packages/cli/test/runs-wait-output.test.ts`), ported to
// node:test: the independent check is a node-test file the verifier writes under checks/, so
// it cannot be the vitest file itself. The cases and their inputs are the reference test's;
// what changes is where the code comes from. It imports the BUILT artifact from the workspace
// root, the way a consumer would, so it grades what `build` produced from the candidate.
const dist = join(process.cwd(), "packages/cli/dist")
const { createRuntimeFetchHandler } = await import(
  join(dist, "lib/dev/runtime-fetch-handler.js")
)
const { normalizeServerResult } = await import(join(dist, "lib/runtime/normalize-server-result.js"))

const cleanup: Array<() => Promise<void> | void> = []
after(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** An app whose routes return exactly what each case needs to observe. */
async function fixtureApp(routes: Record<string, string>): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-factory-runs-wait-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "runs-wait-output-check", "type": "module" }\n',
    ...routes,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** `drainDeadlineMs` keeps a failing case from waiting out the 30s default on close. */
async function handlerFor(routes: Record<string, string>) {
  const appRoot = await fixtureApp(routes)
  const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
  cleanup.push(() => handler.close())
  return { appRoot, handler }
}

function waitRequest(threadId: string, route: string): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/wait`, {
    body: JSON.stringify({ input: {}, route }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

const SILENT = { "src/app/silent/index.ts": "export const workflow = async () => undefined\n" }

/**
 * The verifier's evidence carries only what a check writes to stdout or stderr, never an
 * assertion's own message, so each case prints its own diagnosis before it fails.
 */
async function check(id: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    console.error(`${id} failed: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

test("A1: runs/wait answers 200 with the JSON body null when the route returns nothing", () =>
  check("A1", async () => {
    const { handler } = await handlerFor(SILENT)
    const response = await handler.fetch(waitRequest("th-silent", "/silent#workflow"))
    const text = await response.text()
    assert.equal(`${response.status} ${text}`, "200 null")
  }))

test("A2: B4's own runs/wait client reads that response as a passed run with a null output", () =>
  check("A2", async () => {
    const { appRoot, handler } = await handlerFor(SILENT)
    const response = await handler.fetch(waitRequest("th-silent-client", "/silent#workflow"))
    const result = normalizeServerResult({
      appRoot,
      mode: "workflow",
      responseBodyText: await response.text(),
      routeId: "/silent",
      routePath: "src/app/silent/index.ts",
      startedAt: 0,
      statusCode: response.status,
    })
    assert.equal(result.status, "passed", JSON.stringify(result))
    assert.equal(result.output, null)
  }))

test("A3: runs/wait and runs/stream agree that a route returning nothing succeeded", () =>
  check("A3", async () => {
    const { handler } = await handlerFor(SILENT)
    const streamed = await handler.fetch(
      new Request("http://localhost/threads/th-silent-stream/runs/stream", {
        body: JSON.stringify({ input: {}, route: "/silent#workflow" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    const waited = await handler.fetch(waitRequest("th-silent-parity", "/silent#workflow"))
    assert.equal(streamed.status, 200)
    assert.equal(waited.status, 200)
    // The parsed terminal frame, not a substring: a route that throws also streams a done
    // frame, carrying `output.error`.
    const frames = (await streamed.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    const done = frames.at(-1) ?? {}
    assert.equal("error" in done, false, JSON.stringify(done))
    assert.equal(done.output ?? null, null)
    assert.equal(await waited.text(), "null")
  }))

test("A4: runs/wait carries falsy outputs (0, false, the empty string) unchanged", () =>
  check("A4", async () => {
    const { handler } = await handlerFor({
      "src/app/zero/index.ts": "export const workflow = async () => 0\n",
      "src/app/no/index.ts": "export const workflow = async () => false\n",
      "src/app/empty/index.ts": 'export const workflow = async () => ""\n',
    })
    for (const [route, expected] of [
      ["/zero#workflow", "0"],
      ["/no#workflow", "false"],
      ["/empty#workflow", '""'],
    ] as const) {
      const response = await handler.fetch(waitRequest(`th-${expected}`, route))
      assert.equal(`${route}:${response.status}:${await response.text()}`, `${route}:200:${expected}`)
    }
  }))

test("A5: an output JSON cannot represent answers a named execution_error, not the catch-all", () =>
  check("A5", async () => {
    const { handler } = await handlerFor({
      "src/app/circular/index.ts": [
        "export const workflow = async () => {",
        "  const out: Record<string, unknown> = {}",
        "  out.self = out",
        "  return out",
        "}",
        "",
      ].join("\n"),
      "src/app/bigint/index.ts": "export const workflow = async () => ({ n: 1n })\n",
    })
    for (const route of ["/circular#workflow", "/bigint#workflow"]) {
      const response = await handler.fetch(waitRequest(`th-${route.slice(1, 4)}`, route))
      const body = (await response.json()) as { error: { kind: string; message: string } }
      assert.equal(`${route}:${response.status}`, `${route}:500`)
      assert.equal(body.error.kind, "execution_error")
      assert.ok(
        !body.error.message.includes("Unexpected runtime server failure"),
        `${route}: ${body.error.message}`,
      )
      assert.ok(body.error.message.includes("could not be serialized"), `${route}: ${body.error.message}`)
    }
  }))

test("A6: runs/wait still carries an ordinary object output unchanged", () =>
  check("A6", async () => {
    const { handler } = await handlerFor({
      "src/app/echo/index.ts": "export const workflow = async () => ({ ok: true, n: 1 })\n",
    })
    const response = await handler.fetch(waitRequest("th-echo", "/echo#workflow"))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { n: 1, ok: true })
  }))
