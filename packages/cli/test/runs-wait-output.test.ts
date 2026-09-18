import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { normalizeServerResult } from "../src/lib/runtime/normalize-server-result.js"

// ---------------------------------------------------------------------------
// What `POST /threads/:id/runs/wait` puts on the wire for a route's output.
//
// The response body IS the route's return value, and that value is whatever
// the route function returned — `unknown`, `undefined` included. A route that
// returns nothing used to reach `Response.json(undefined)`, which throws, so
// the endpoint answered 500 while `runs/stream` answered fine for the same
// run (issue #714).
//
// The fix sends JSON `null` rather than restoring the pre-#373 empty body:
// `normalizeServerResult` — B4's own client for this endpoint — requires a 200
// body to parse, and `JSON.parse("")` throws, so an empty body would trade the
// 500 for a "malformed JSON payload" transport error.
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** An app whose routes return exactly what each test needs to observe. */
async function fixtureApp(routes: Record<string, string>): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-runs-wait-output-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "runs-wait-output-fixture", "type": "module" }\n',
    ...routes,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/**
 * `drainDeadlineMs` keeps `handler.close()` from waiting out the 30s default
 * when a failing assertion leaves an SSE body unconsumed — a failure here
 * should report in milliseconds, not stall the suite.
 */
function waitRequest(threadId: string, route: string): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/wait`, {
    body: JSON.stringify({ input: {}, route }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

describe("runs/wait output serialization", () => {
  it("answers 200 with JSON null when the route returns nothing", async () => {
    const appRoot = await fixtureApp({
      "src/app/silent/index.ts": "export const workflow = async () => undefined\n",
    })
    const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(waitRequest("th-silent", "/silent#workflow"))

    expect(response.status).toBe(200)
    // Valid JSON, so the client below can parse it — an empty body could not be.
    expect(await response.text()).toBe("null")
  })

  it("leaves that response a success for B4's own runs/wait client", async () => {
    const appRoot = await fixtureApp({
      "src/app/silent/index.ts": "export const workflow = async () => undefined\n",
    })
    const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => handler.close())

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

    // The point of choosing `null` over an empty body: this stays a success
    // rather than becoming a server_transport_error.
    expect(result.status).toBe("passed")
    expect(result.status === "passed" ? result.output : undefined).toBeNull()
  })

  // The complaint in #714 was that the two endpoints disagreed about the same
  // run: wait said 500, stream said done. This pins them together.
  it("agrees with runs/stream about a route that returns nothing", async () => {
    const appRoot = await fixtureApp({
      "src/app/silent/index.ts": "export const workflow = async () => undefined\n",
    })
    const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => handler.close())

    const streamed = await handler.fetch(
      new Request("http://localhost/threads/th-silent-stream/runs/stream", {
        body: JSON.stringify({ input: {}, route: "/silent#workflow" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    const waited = await handler.fetch(waitRequest("th-silent-parity", "/silent#workflow"))

    expect(streamed.status).toBe(200)
    expect(waited.status).toBe(200)

    // Assert the parsed terminal frame, not just that "done" appears in the
    // text: a route that THROWS also streams a done frame (carrying
    // `output.error`), so a substring check would pass for a failed run and
    // prove nothing about agreement.
    const frames = (await streamed.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    const done = frames.at(-1) ?? {}

    expect(done).not.toHaveProperty("error")
    // Both call it a success with no output. They spell it differently — the
    // stream drops the key that `JSON.stringify` cannot represent, the body
    // says `null` — but neither reports a failure any more.
    expect(done.output ?? null).toBeNull()
    expect(await waited.text()).toBe("null")
  })

  it("does not flatten falsy outputs into null", async () => {
    const appRoot = await fixtureApp({
      "src/app/zero/index.ts": "export const workflow = async () => 0\n",
      "src/app/no/index.ts": "export const workflow = async () => false\n",
      "src/app/empty/index.ts": 'export const workflow = async () => ""\n',
    })
    const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => handler.close())

    for (const [route, expected] of [
      ["/zero#workflow", "0"],
      ["/no#workflow", "false"],
      ["/empty#workflow", '""'],
    ] as const) {
      const response = await handler.fetch(waitRequest(`th-${expected}`, route))
      expect(`${route}:${response.status}`).toBe(`${route}:200`)
      expect(`${route}:${await response.text()}`).toBe(`${route}:${expected}`)
    }
  })

  // The same user-visible symptom as #714 — a run that executed fine reported
  // as an opaque "Unexpected runtime server failure" — is reachable for any
  // output `JSON.stringify` refuses, not just `undefined`. Name it instead.
  it("names the route when the output cannot be serialized", async () => {
    const appRoot = await fixtureApp({
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
    const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => handler.close())

    for (const route of ["/circular#workflow", "/bigint#workflow"]) {
      const response = await handler.fetch(waitRequest(`th-${route.slice(1, 4)}`, route))
      const body = (await response.json()) as {
        error: { kind: string; message: string; details?: Record<string, unknown> }
      }
      expect(`${route}:${response.status}`).toBe(`${route}:500`)
      expect(body.error.kind).toBe("execution_error")
      // Actionable: says the output is at fault and which route produced it,
      // rather than the catch-all the outer handler used to emit.
      expect(`${route}:${body.error.message}`).not.toContain("Unexpected runtime server failure")
      expect(body.error.message).toContain("could not be serialized")
    }
  })

  it("still carries an ordinary object output unchanged", async () => {
    const appRoot = await fixtureApp({
      "src/app/echo/index.ts": "export const workflow = async () => ({ ok: true, n: 1 })\n",
    })
    const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(waitRequest("th-echo", "/echo#workflow"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ n: 1, ok: true })
  })
})
