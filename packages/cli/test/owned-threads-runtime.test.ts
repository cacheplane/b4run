import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ownedThreads } from "@b4run/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { headerAuth } from "./helpers/header-auth.ts"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function setup() {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-owned-threads-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  for (const [relativePath, source] of Object.entries({
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "owned-threads-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": "export const graph = async () => ({ ok: true })\n",
  })) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  const handler = await createRuntimeFetchHandler({
    appRoot,
    auth: headerAuth("x-user"),
    drainDeadlineMs: 250,
    threadAccess: ownedThreads(),
  })
  cleanup.push(() => handler.close())
  return handler
}

const call = (method: string, path: string, user?: string, body?: unknown) =>
  new Request(new URL(path, "http://localhost"), {
    method,
    headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

describe("ownedThreads behind the runtime", () => {
  it("lets each caller reach only the threads it created", async () => {
    const handler = await setup()
    const created = await handler.fetch(call("POST", "/threads", "alice", { metadata: {} }))
    expect(created.status).toBe(200)
    const { thread_id } = (await created.json()) as { thread_id: string }

    expect((await handler.fetch(call("GET", `/threads/${thread_id}`, "alice"))).status).toBe(200)
    // Not yours reads exactly like never existed.
    expect((await handler.fetch(call("GET", `/threads/${thread_id}`, "bob"))).status).toBe(404)
    expect((await handler.fetch(call("GET", "/threads/never-made", "bob"))).status).toBe(404)
    expect((await handler.fetch(call("GET", `/threads/${thread_id}`))).status).toBe(404)
    expect(
      (await handler.fetch(call("POST", "/threads", undefined, { metadata: {} }))).status,
    ).toBe(403)
  })
})
