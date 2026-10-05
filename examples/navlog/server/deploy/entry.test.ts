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

const TOKEN = "test-secret-0123456789abcdefghijklmnop"

/** Boots main.mjs with `env` and resolves with its exit code and stderr. */
async function bootAndExit(
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  const proc = spawn(process.execPath, ["main.mjs"], {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      B4_ALLOW_UNGUARDED: "",
      RAILWAY_ENVIRONMENT: "",
      RAILWAY_ENVIRONMENT_NAME: "",
      RAILWAY_ENVIRONMENT_ID: "",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  })
  let stderr = ""
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const [code] = (await once(proc, "exit")) as [number | null]
  return { code, stderr }
}

describe("main.mjs refuses to boot unguarded as a deployment", () => {
  it("exits when DATABASE_URL is set and B4_INTERNAL_TOKEN is not", async () => {
    const { code, stderr } = await bootAndExit({
      B4_INTERNAL_TOKEN: "",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:1/never",
    })
    expect(code).not.toBe(0)
    expect(stderr).toContain("Refusing to boot: B4_INTERNAL_TOKEN is not set")
  })

  it("exits on Railway without a token, whichever environment variable says so", async () => {
    for (const name of [
      "RAILWAY_ENVIRONMENT",
      "RAILWAY_ENVIRONMENT_NAME",
      "RAILWAY_ENVIRONMENT_ID",
    ]) {
      const { code, stderr } = await bootAndExit({
        B4_INTERNAL_TOKEN: "",
        DATABASE_URL: "",
        [name]: "production",
      })
      expect(code).not.toBe(0)
      expect(stderr).toContain("Refusing to boot: B4_INTERNAL_TOKEN is not set")
    }
  })

  it("boots unguarded on Railway when B4_ALLOW_UNGUARDED=1 says so", async () => {
    const proc = spawn(process.execPath, ["main.mjs"], {
      cwd: appRoot,
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        B4_INTERNAL_TOKEN: "",
        DATABASE_URL: "",
        RAILWAY_ENVIRONMENT: "production",
        B4_ALLOW_UNGUARDED: "1",
      },
      stdio: ["ignore", "pipe", "inherit"],
    })
    try {
      const listening = await waitForListening(proc)
      const res = await fetch(new URL("/healthz", listening))
      expect(res.status).toBe(200)
    } finally {
      proc.kill("SIGTERM")
      if (proc.exitCode === null) await once(proc, "exit")
    }
  })

  it("exits when the token is shorter than 32 characters", async () => {
    const { code, stderr } = await bootAndExit({ B4_INTERNAL_TOKEN: "short", DATABASE_URL: "" })
    expect(code).not.toBe(0)
    expect(stderr).toContain("at least 32 characters")
  })
})

describe("main.mjs behind the internal-token guard", () => {
  beforeAll(async () => {
    child = spawn(process.execPath, ["main.mjs"], {
      cwd: appRoot,
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        B4_INTERNAL_TOKEN: TOKEN,
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
        "x-internal-token": TOKEN,
        "x-b4-visitor": "v-deploytest",
      },
      body: "{}",
    })
    expect(res.status).toBe(200)
  })

  it("keeps a visitor's thread from every other visitor", async () => {
    const as = (visitor: string) => ({
      "content-type": "application/json",
      "x-internal-token": TOKEN,
      "x-b4-visitor": visitor,
    })
    const created = await fetch(new URL("/threads", url), {
      method: "POST",
      headers: as("v-owner0001"),
      body: "{}",
    })
    expect(created.status).toBe(200)
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }

    const own = await fetch(new URL(`/threads/${threadId}`, url), { headers: as("v-owner0001") })
    expect(own.status).toBe(200)
    const other = await fetch(new URL(`/threads/${threadId}`, url), { headers: as("v-other0001") })
    expect(other.status).not.toBe(200)
    const anonymous = await fetch(new URL(`/threads/${threadId}`, url), {
      headers: { "x-internal-token": TOKEN },
    })
    expect(anonymous.status).not.toBe(200)
  })
})
