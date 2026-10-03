import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AGUI_BODY_MAX_BYTES } from "../src/lib/dev/request-limits.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function setup() {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-ap-limit-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  await mkdir(join(appRoot, "src/app/echo"), { recursive: true })
  await writeFile(join(appRoot, "b4.config.ts"), "export default {}\n")
  await writeFile(join(appRoot, "package.json"), '{ "name": "x", "type": "module" }\n')
  await writeFile(
    join(appRoot, "src/app/echo/index.ts"),
    "export const graph = async (input) => ({ echoed: input.messages?.[0]?.content ?? null })\n",
  )
  const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
  cleanup.push(() => handler.close())
  return handler
}

async function createThread(handler: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const res = await handler.fetch(
    new Request("http://localhost/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  )
  return ((await res.json()) as { thread_id: string }).thread_id
}

describe("Agent Protocol run body", () => {
  it("is bounded like the AG-UI body: a declared over-cap length is 413 unread", async () => {
    const handler = await setup()
    const threadId = await createThread(handler)
    const res = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}/runs/wait`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(AGUI_BODY_MAX_BYTES + 1),
        },
        body: JSON.stringify({ route: "/echo#graph", input: {} }),
      }),
    )
    expect(res.status).toBe(413)
  })

  it("carries array content to the route intact", async () => {
    const handler = await setup()
    const threadId = await createThread(handler)
    const parts = [
      { type: "text", text: "see" },
      { type: "image", source: { type: "url", value: "https://x.test/a.png" } },
    ]
    const res = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}/runs/wait`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          route: "/echo#graph",
          input: { messages: [{ role: "user", content: parts }] },
        }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { echoed?: unknown } | { output?: { echoed?: unknown } }
    expect(JSON.stringify(body)).toContain(JSON.stringify(parts))
  })
})
