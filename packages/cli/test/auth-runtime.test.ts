import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type AuthDefinition,
  defineAuth,
  type MiddlewareHandler,
  reject,
  type ThreadAccessPolicy,
} from "@b4run/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { loadAuth } from "../src/lib/dev/auth-node.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const ECHO_ROUTE = "/echo#graph"
const CHAT_ROUTE = "/chat#agent"

async function scratchApp(extra: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-auth-runtime-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "auth-runtime-fixture", "type": "module" }\n',
    // A graph route sees the request's principal on its context, as every tool does.
    "src/app/echo/index.ts":
      "export const graph = async (_input, ctx) => ({ principal: ctx.principal ?? null })\n",
    "src/app/chat/index.ts": [
      'import { agent } from "@b4run/sdk"',
      'export default agent({ model: "gpt-5-mini", systemPrompt: "Use whoAmI when asked." })',
      "",
    ].join("\n"),
    "src/app/chat/tools/whoAmI.ts": [
      "export default async function whoAmI(_input: Record<string, never>, ctx: { principal?: { id: string } }) {",
      '  return ctx.principal?.id ?? "anonymous"',
      "}",
      "",
    ].join("\n"),
    ...extra,
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  return appRoot
}

interface Seen {
  authenticate: number
  middleware: unknown[]
  threadAccess: unknown[]
}

async function setup(auth: AuthDefinition | undefined) {
  const seen: Seen = { authenticate: 0, middleware: [], threadAccess: [] }
  const counted = auth
    ? defineAuth({
        authenticate: async (req) => {
          seen.authenticate++
          return await auth.authenticate(req)
        },
      })
    : undefined
  const middleware: MiddlewareHandler = (req) => {
    seen.middleware.push(req.principal)
    return { action: "continue" }
  }
  const threadAccess: ThreadAccessPolicy = {
    fallback: (req) => {
      seen.threadAccess.push(req.principal)
      return { decision: "allow" }
    },
  }
  const appRoot = await scratchApp()
  const handler = await createRuntimeFetchHandler({
    appRoot,
    ...(counted ? { auth: counted } : {}),
    drainDeadlineMs: 250,
    middleware,
    threadAccess,
  })
  cleanup.push(() => handler.close())
  return { handler, seen }
}

/** `src/auth.ts` resolving `{ id }` from `x-user`, anonymous without it. */
const userAuth = defineAuth({
  authenticate: ({ headers }) => (headers["x-user"] ? { id: headers["x-user"] } : undefined),
})

function runWait(threadId: string, route: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/wait`, {
    body: JSON.stringify({ input: {}, route }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  })
}

describe("src/auth.ts in the runtime", () => {
  it("resolves the principal once and hands the same value to middleware, thread access and the route", async () => {
    const { handler, seen } = await setup(userAuth)
    const response = await handler.fetch(runWait("t-1", ECHO_ROUTE, { "x-user": "u-1" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ principal: { id: "u-1" } })
    expect(seen.authenticate).toBe(1)
    expect(seen.middleware).toEqual([{ id: "u-1" }])
    expect(seen.threadAccess.length).toBeGreaterThan(0)
    for (const principal of seen.threadAccess) expect(principal).toEqual({ id: "u-1" })
    // Shallow-frozen: no consumer can rewrite the caller for the next one.
    expect(Object.isFrozen(seen.middleware[0])).toBe(true)
  })

  it("resolves once on an endpoint that runs thread access before middleware", async () => {
    const { handler, seen } = await setup(userAuth)
    await handler.fetch(runWait("t-2", ECHO_ROUTE, { "x-user": "u-2" }))
    seen.authenticate = 0
    seen.middleware = []
    seen.threadAccess = []
    const response = await handler.fetch(
      new Request("http://localhost/threads/t-2/pending_interrupts", {
        headers: { "x-user": "u-2" },
      }),
    )
    expect(response.status).toBe(200)
    expect(seen.authenticate).toBe(1)
    expect(seen.threadAccess).toEqual([{ id: "u-2" }])
  })

  it("treats an undefined result as an anonymous request", async () => {
    const { handler, seen } = await setup(userAuth)
    const response = await handler.fetch(runWait("t-3", ECHO_ROUTE))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ principal: null })
    expect(seen.middleware).toEqual([undefined])
  })

  it("answers a rejection before any gate runs", async () => {
    const { handler, seen } = await setup(
      defineAuth({ authenticate: () => reject(401, { error: "unauthorized" }) }),
    )
    const response = await handler.fetch(runWait("t-4", ECHO_ROUTE))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "unauthorized" })
    expect(seen.middleware).toEqual([])
    expect(seen.threadAccess).toEqual([])
  })

  it.each([
    ["a throw", () => Promise.reject(new Error("token service down"))],
    ["a principal without a string id", () => ({ id: 42 }) as never],
    ["a string", () => "u-1" as never],
  ])("fails the request with a 500 on %s, never as anonymous", async (_label, authenticate) => {
    const { handler, seen } = await setup(defineAuth({ authenticate }))
    const response = await handler.fetch(runWait("t-5", ECHO_ROUTE))
    expect(response.status).toBe(500)
    expect(seen.middleware).toEqual([])
    expect(seen.threadAccess).toEqual([])
  })

  it("does not authenticate the liveness and readiness probes", async () => {
    const { handler, seen } = await setup(defineAuth({ authenticate: () => reject(401) }))
    expect((await handler.fetch(new Request("http://localhost/healthz"))).status).toBe(200)
    expect((await handler.fetch(new Request("http://localhost/readyz"))).status).toBe(200)
    expect(seen.authenticate).toBe(0)
  })

  it("with no auth file, every request is anonymous", async () => {
    const { handler, seen } = await setup(undefined)
    const response = await handler.fetch(runWait("t-6", ECHO_ROUTE, { "x-user": "u-6" }))
    expect(await response.json()).toMatchObject({ principal: null })
    expect(seen.middleware).toEqual([undefined])
  })

  it("gives each request's tools that request's principal, never a cached graph's", async () => {
    const aimock = await createAimock({ fixtures: [] })
    cleanup.push(() => aimock.close())
    const prevBaseUrl = process.env.OPENAI_BASE_URL
    const prevKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_BASE_URL = aimock.baseUrl
    process.env.OPENAI_API_KEY = prevKey ?? "test-not-used"
    cleanup.push(() => {
      if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = prevBaseUrl
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
    })
    aimock.addFixtures(script().user("who am i").callsTool("whoAmI", {}).replies("done").build())
    const { handler } = await setup(userAuth)
    const ask = async (threadId: string, user: string) => {
      const response = await handler.fetch(
        new Request(`http://localhost/threads/${threadId}/runs/wait`, {
          body: JSON.stringify({
            input: { messages: [{ content: "who am i", role: "user" }] },
            route: CHAT_ROUTE,
          }),
          headers: { "content-type": "application/json", "x-user": user },
          method: "POST",
        }),
      )
      expect(response.status).toBe(200)
      // LangChain-serialized messages: the tool's result is its JSON-encoded return value.
      const { messages } = (await response.json()) as {
        messages: { id: string[]; kwargs: { content: string } }[]
      }
      const tool = messages.find((message) => message.id.at(-1) === "ToolMessage")
      return tool ? JSON.parse(tool.kwargs.content) : undefined
    }
    // Sequential, then concurrent: a graph cached for the first caller would
    // hand the second caller's tool the first caller's principal.
    expect(await ask("chat-a", "alice")).toBe("alice")
    expect(await ask("chat-b", "bob")).toBe("bob")
    const [carol, dave] = await Promise.all([ask("chat-c", "carol"), ask("chat-d", "dave")])
    expect([carol, dave]).toEqual(["carol", "dave"])
  }, 30_000)
})

describe("loadAuth", () => {
  it("resolves no auth when the app has no auth file", async () => {
    expect(await loadAuth(await scratchApp())).toBeUndefined()
  })

  it("binds a defineAuth default export", async () => {
    const appRoot = await scratchApp({
      "src/auth.ts": [
        'import { defineAuth } from "@b4run/sdk"',
        "export default defineAuth({ authenticate: () => undefined })",
        "",
      ].join("\n"),
    })
    const auth = await loadAuth(appRoot, {
      importModule: async () => ({
        default: defineAuth({ authenticate: () => undefined }),
      }),
    })
    expect(auth?.authenticate).toBeTypeOf("function")
  })

  it.each([
    ["no default export", { principalOf: () => undefined }, /no default export/],
    [
      "a plain-object default",
      { default: { authenticate: () => undefined } },
      /did not come from `defineAuth`/,
    ],
  ])("fails the boot (B4_E3005) on %s", async (_label, mod, message) => {
    const appRoot = await scratchApp({ "src/auth.ts": "export {}\n" })
    const loading = loadAuth(appRoot, { importModule: async () => mod })
    await expect(loading).rejects.toThrow(message)
    await expect(loadAuth(appRoot, { importModule: async () => mod })).rejects.toMatchObject({
      code: "B4_E3005",
    })
  })

  it("fails the boot when the auth file does not import", async () => {
    const appRoot = await scratchApp({ "src/auth.ts": "export {}\n" })
    await expect(
      loadAuth(appRoot, { importModule: () => Promise.reject(new Error("boom")) }),
    ).rejects.toMatchObject({ code: "B4_E3005" })
  })

  it("fails the boot when the auth file cannot be probed", async () => {
    const appRoot = await scratchApp()
    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" })
    await expect(
      loadAuth(appRoot, {
        statPath: () => {
          throw eacces
        },
      }),
    ).rejects.toMatchObject({ code: "B4_E3005" })
  })
})
