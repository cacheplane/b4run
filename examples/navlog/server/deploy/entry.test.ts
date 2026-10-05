import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Boots the production entry (main.mjs) the way the Railway image does. Needs
// `b4 build` output, so it runs through `npm run test:deploy`, not `npm test`.
const appRoot = fileURLToPath(new URL("..", import.meta.url))
let child: ReturnType<typeof spawn>
let url = ""

async function waitForListening(proc: ReturnType<typeof spawn>): Promise<string> {
  let buffer = ""
  for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
    buffer += chunk.toString()
    const m = /listening on (http:\/\/[^\s]+)/.exec(buffer)
    if (m) return m[1] as string
  }
  throw new Error(`entry exited before listening:\n${buffer}`)
}

describe("main.mjs behind the internal-token guard", () => {
  beforeAll(async () => {
    child = spawn(process.execPath, ["main.mjs"], {
      cwd: appRoot,
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        B4_INTERNAL_TOKEN: "test-secret",
        DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "inherit"],
    })
    url = await waitForListening(child)
  }, 60_000)

  afterAll(async () => {
    if (child.exitCode !== null) return
    child.kill("SIGTERM")
    await once(child, "exit")
  })

  it("answers the health check without a token", async () => {
    const res = await fetch(new URL("/healthz", url))
    expect(res.status).toBe(200)
  })

  it("refuses a runtime route without the token", async () => {
    const res = await fetch(new URL("/threads", url), { method: "POST", body: "{}" })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
  })

  it("refuses a runtime route with the wrong token", async () => {
    const res = await fetch(new URL("/threads", url), {
      method: "POST",
      headers: { "x-internal-token": "not-the-secret" },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  it("serves a runtime route with the token", async () => {
    const res = await fetch(new URL("/threads", url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": "test-secret",
        "x-b4-visitor": "v-deploytest",
      },
      body: "{}",
    })
    expect(res.status).toBe(200)
  })
})
