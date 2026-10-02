import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import { createGitHubAdapter } from "../src/lib/delivery/github/adapter.ts"
import { allowedRoute } from "../src/lib/delivery/github/http.ts"
import { BRANCH, closeHarness, harness } from "./delivery-harness.ts"
import {
  type FakeGitHubServer,
  INSTALLATION_TOKEN,
  startFakeGitHubServer,
} from "./fake-github-server.ts"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })

let server: FakeGitHubServer | undefined
afterEach(async () => {
  closeHarness()
  await server?.close()
  server = undefined
})

describe("the GitHub adapter against GitHub's shapes", () => {
  /** Every request the adapter sends, as fetch received it. */
  let sent: { method: string; path: string; body: unknown }[] = []
  async function delivery(
    options: {
      readonly requestTimeoutMs?: number
      /** Called as fetch is handed each request: a test closes the controller here. */
      readonly beforeFetch?: (method: string, path: string) => void
    } = {},
  ) {
    server = await startFakeGitHubServer()
    sent = []
    const recording: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      sent.push({
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      options.beforeFetch?.(init?.method ?? "GET", url.pathname)
      return fetch(input, init)
    }
    const adapter = createGitHubAdapter({
      repository: "cacheplane/b4run",
      appId: 123456,
      privateKey,
      baseBranch: "main",
      baseUrl: server.url,
      fetch: recording,
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    })
    const h = await harness({ github: server.repo, adapter })
    return { h, server, adapter }
  }

  it("delivers end to end with GET and POST only, the JWT only for the app's own endpoints", async () => {
    const { h, server } = await delivery()
    expect((await h.deliver()).state).toBe("delivered")
    expect(new Set(server.requests.map((r) => r.method))).toEqual(new Set(["GET", "POST"]))
    for (const r of server.requests)
      expect(r.auth, r.path).toBe(/^\/app($|\/)|\/installation$/.test(r.path) ? "Bearer" : "token")
    // Every request fetch was handed is one the allow-list accepts, as sent.
    for (const r of sent)
      expect(
        () =>
          allowedRoute(r.method, r.path, r.body, {
            repository: "cacheplane/b4run",
            baseBranch: "main",
          }),
        r.path,
      ).not.toThrow()
    // The token is minted for the installation id the adapter just read, and nothing wider.
    const mint = server.requests.find((r) => r.path === "/app/installations/42/access_tokens")
    expect(mint?.body).toEqual({
      repositories: ["b4run"],
      permissions: { contents: "write", pull_requests: "write", metadata: "read", issues: "read" },
    })
    const created = server.requests.find((r) => r.method === "POST" && r.path.endsWith("/pulls"))
    expect(created?.body).toMatchObject({ draft: true, base: "main", head: BRANCH })
    expect(h.journal()).not.toContain(INSTALLATION_TOKEN)
  })

  it("answers a lost ref create's 422 and a lost PR create's 422 by reading", async () => {
    const { h, server } = await delivery()
    server.answer("POST", /\/git\/refs$/, { status: 502, after: true })
    server.answer("POST", /\/pulls$/, { status: 504, after: true })
    expect((await h.deliver()).state).toBe("delivered")
    expect(server.repo.pulls).toHaveLength(1)
  })

  it("classifies 401, a plain 403, a rate-limit 403 and a 429 as GitHub means them", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 5)
    const limited = await delivery()
    limited.server.answer("GET", /\/compare\//, {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
    })
    limited.server.answer("GET", /\/git\/trees\//, { status: 429, headers: { "retry-after": "7" } })
    expect((await limited.h.deliver()).state).toBe("delivered")
    expect(limited.h.waits[1]).toBe(7_000)
    closeHarness()
    await server?.close()

    const forbidden = await delivery()
    forbidden.server.answer("GET", /\/compare\//, {
      status: 403,
      body: { message: "Resource not accessible by integration" },
    })
    expect(await forbidden.h.deliver()).toMatchObject({ blockedReason: "delivery_unauthorized" })
  })

  it("refuses a mint narrower than delivery needs, and an app not installed", async () => {
    const narrow = await delivery()
    narrow.server.granted = { contents: "read", pull_requests: "write", metadata: "read" }
    expect(await narrow.h.deliver()).toMatchObject({ blockedReason: "delivery_unauthorized" })
    expect(narrow.h.journal()).toContain("contents: write")
    closeHarness()
    await server?.close()

    const absent = await delivery()
    absent.server.installed = false
    expect(await absent.h.deliver()).toMatchObject({ blockedReason: "delivery_unauthorized" })
    expect(absent.h.journal()).toContain("not installed")
  })

  it("refuses a comparison of 300 files as unverifiable", async () => {
    const { h, server } = await delivery()
    server.repo.comparison = { status: "ahead", aheadBy: 400, files: [], complete: false }
    expect(await h.deliver()).toMatchObject({ blockedReason: "delivery_base_conflict" })
  })

  it("refuses a tree listing GitHub truncated, rather than reading part of it", async () => {
    const { h, server, adapter } = await delivery()
    const listed = { sha: h.pin, truncated: true, tree: [] }
    server.answer("GET", /\/git\/trees\//, { status: 200, body: listed })
    const session = await adapter.open("cacheplane/b4run", new AbortController().signal)
    const tree = (server.repo.commits.get(h.pin) as { tree: string }).tree
    await expect(session.tree(tree)).rejects.toEqual(
      new DeliveryError("unexpected", `tree ${tree} was truncated`),
    )

    // In a delivery, the cause is named, not hashed into a guess.
    server.answer("GET", /\/git\/trees\//, { status: 200, body: listed })
    const row = await h.deliver()
    expect(row).toMatchObject({ state: "blocked", blockedReason: "delivery_unconfirmed" })
    expect(h.journal()).toContain("was truncated")
    expect(server.repo.writes()).toEqual([])
  })

  it("never follows a redirect: a 307 blocks, and its target is never asked", async () => {
    const { h, server } = await delivery()
    server.answer("POST", /\/git\/refs$/, {
      status: 307,
      headers: { location: `${server.url}/repos/cacheplane/other/git/refs` },
    })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(server.requests.some((r) => r.path.includes("/cacheplane/other/"))).toBe(false)
  })

  it("gives up on a request past its bound and retries the step", async () => {
    const { h, server } = await delivery({ requestTimeoutMs: 200 })
    server.answer("GET", /\/compare\//, { status: 200, delayMs: 1_000 })
    expect((await h.deliver()).state, h.journal()).toBe("delivered")
    expect(h.waits).toEqual([2_000])
    expect(h.journal()).toContain("no answer within 200 ms")
  })

  it("stays delivering when the controller closes mid-request, and resumes after", async () => {
    let abort: (() => void) | undefined
    const { h } = await delivery({
      beforeFetch: (method, path) => {
        if (method === "POST" && path.endsWith("/git/refs")) abort?.()
      },
    })
    const stopped = await h.deliver({
      onEvent: (type, a) => {
        if (type === "delivery_committed") abort = a
      },
    })
    expect(stopped).toMatchObject({ state: "delivering", blockedReason: null })
    expect(h.events()).toContain("delivery_stopped")
    abort = undefined
    expect((await h.deliver()).state).toBe("delivered")
  })

  it("delivers only to the repository it was configured for", async () => {
    const { adapter } = await delivery()
    await expect(adapter.open("cacheplane/other", new AbortController().signal)).rejects.toEqual(
      new DeliveryError(
        "unauthorized",
        "this controller delivers to cacheplane/b4run, not cacheplane/other",
      ),
    )
  })
})
