import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import { createGitHubAdapter } from "../src/lib/delivery/github/adapter.ts"
import { allowedRoute } from "../src/lib/delivery/github/http.ts"
import { REDELIVERABLE_BLOCKED_REASONS } from "../src/lib/domain/states.ts"
import { BRANCH, closeHarness, harness } from "./delivery-harness.ts"
import { REPOSITORY } from "./fake-delivery-adapter.ts"
import { type FakeGitHubServer, startFakeGitHubServer } from "./fake-github-server.ts"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const BOT_EMAIL = "123+b4-factory[bot]@users.noreply.github.com"

let server: FakeGitHubServer | undefined
afterEach(async () => {
  closeHarness()
  await server?.close()
  server = undefined
})

/** Close the last delivery's harness and server, so a test can start another. */
async function reset() {
  closeHarness()
  await server?.close()
  server = undefined
}

describe("the GitHub adapter against GitHub's shapes", () => {
  /** Every request the adapter sends, as fetch received it. */
  let sent: { method: string; path: string; body: unknown }[] = []
  async function delivery(
    options: {
      readonly requestTimeoutMs?: number
      /** Called as fetch is handed each request: a test closes the controller here. */
      readonly beforeFetch?: (method: string, path: string) => void
      /** The adapter's and the server's clock. */
      readonly now?: () => number
    } = {},
  ) {
    server = await startFakeGitHubServer()
    if (options.now !== undefined) server.now = options.now
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
      repository: REPOSITORY,
      appId: 123456,
      privateKey,
      baseBranch: "main",
      baseUrl: server.url,
      fetch: recording,
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
    const h = await harness({ github: server.repo, adapter })
    return { h, server, adapter }
  }
  const statuses = (s: FakeGitHubServer, method: string, path: RegExp) =>
    s.requests.filter((r) => r.method === method && path.test(r.path)).map((r) => r.status)

  it("delivers end to end with GET and POST only, the JWT only for the app's own endpoints", async () => {
    const { h, server, adapter } = await delivery()
    expect((await h.deliver()).state).toBe("delivered")
    expect(new Set(server.requests.map((r) => r.method))).toEqual(new Set(["GET", "POST"]))
    for (const r of server.requests)
      expect(r.auth, r.path).toBe(/^\/app($|\/)|\/installation$/.test(r.path) ? "Bearer" : "token")
    // Every request under a token carried the one this run minted, and GitHub honoured it.
    expect(server.tokens).toHaveLength(1)
    for (const r of server.requests.filter((q) => q.auth === "token")) {
      expect(r.token, r.path).toBe(0)
      expect(r.status, r.path).not.toBe(401)
    }
    // Every request fetch was handed is one the allow-list accepts, as sent.
    for (const r of sent)
      expect(
        () =>
          allowedRoute(r.method, r.path, r.body, { repository: REPOSITORY, baseBranch: "main" }),
        r.path,
      ).not.toThrow()
    // The token is minted for the installation id the adapter just read, and nothing wider.
    const mint = server.requests.find((r) => r.path === "/app/installations/42/access_tokens")
    expect(mint?.body).toEqual({
      repositories: ["b4run"],
      permissions: { contents: "write", pull_requests: "write", metadata: "read", issues: "read" },
    })
    // The repository was read under the token before anything else in it.
    expect(
      server.requests.some((r) => r.method === "GET" && r.path === `/repos/${REPOSITORY}`),
    ).toBe(true)
    // The commit is the bot's, as author and committer, under its noreply address by user id.
    const commit = server.requests.find(
      (r) => r.method === "POST" && r.path.endsWith("/git/commits"),
    )
    const body = commit?.body as {
      author: Record<string, string>
      committer: Record<string, string>
    }
    expect(body.author).toMatchObject({ name: "b4-factory[bot]", email: BOT_EMAIL })
    expect(body.committer).toEqual(body.author)
    // Pull requests are looked up by `<owner>:<branch>`, which is how GitHub filters by head.
    const listings = server.requests.filter((r) => r.method === "GET" && /\/pulls\?/.test(r.path))
    expect(listings.length).toBeGreaterThan(0)
    for (const r of listings)
      expect(new URL(r.path, "http://x").searchParams.get("head")).toBe(`cacheplane:${BRANCH}`)
    const created = server.requests.find((r) => r.method === "POST" && r.path.endsWith("/pulls"))
    expect(created?.body).toMatchObject({ draft: true, base: "main", head: BRANCH })
    // The closing-issues query read this pull request, by its number.
    const query = server.requests.find((r) => r.path === "/graphql")?.body as
      | { variables: { number: number } }
      | undefined
    expect(query?.variables.number).toBe(server.repo.pulls[0]?.number)
    // Booleans only: a token never reaches an assertion message.
    expect(server.tokens.some((t) => h.journal().includes(t))).toBe(false)
    expect(adapter.secrets().length === 1 && adapter.secrets()[0] === server.tokens[0]).toBe(true)
  })

  it("answers GitHub's real 422 for a ref that exists, after the create's answer was lost", async () => {
    const { h, server } = await delivery()
    // The first create lands and its answer is lost; the retry's read misses the new ref (a
    // replica behind), so the create is sent again and GitHub answers it as it does.
    server.answer(
      "GET",
      /\/git\/ref\/heads\/factory\//,
      { status: 404, body: { message: "Not Found" } },
      2,
    )
    server.answer("POST", /\/git\/refs$/, { status: 502, after: true })
    expect((await h.deliver()).state, h.journal()).toBe("delivered")
    expect(statuses(server, "POST", /\/git\/refs$/)).toEqual([502, 422])
    expect(server.repo.refs.get(BRANCH)).toBeDefined()
  })

  it("answers GitHub's real 422 for a pull request that exists, after the create's answer was lost", async () => {
    const { h, server } = await delivery()
    server.answer("GET", /\/pulls\?head=/, { status: 200, body: [] }, 2)
    server.answer("POST", /\/pulls$/, { status: 504, after: true })
    expect((await h.deliver()).state, h.journal()).toBe("delivered")
    expect(statuses(server, "POST", /\/pulls$/)).toEqual([504, 422])
    expect(server.repo.pulls).toHaveLength(1)
  })

  it("mints a token per session, scrubs every one, and re-mints one near its expiry", async () => {
    let clock = Date.parse("2026-10-01T12:00:00Z")
    const { server, adapter } = await delivery({ now: () => clock })
    const first = await adapter.open(REPOSITORY, new AbortController().signal)
    const second = await adapter.open(REPOSITORY, new AbortController().signal)
    expect(server.tokens).toHaveLength(2)
    expect(server.tokens[0] !== server.tokens[1]).toBe(true)
    const secrets = adapter.secrets()
    expect(secrets.length === 2 && server.tokens.every((t) => secrets.includes(t))).toBe(true)
    // Each session uses its own token.
    await first.issueState(912)
    expect(server.requests.at(-1)?.token).toBe(0)
    await second.issueState(912)
    expect(server.requests.at(-1)?.token).toBe(1)

    // Five minutes before the hour is up, the next request is made under a fresh token.
    clock += 54 * 60_000
    await first.issueState(912)
    expect(server.tokens).toHaveLength(2)
    clock += 2 * 60_000
    await first.issueState(912)
    expect(server.tokens).toHaveLength(3)
    expect(server.requests.at(-1)?.token).toBe(2)
    expect(
      adapter.secrets().length === 3 && adapter.secrets().includes(server.tokens[2] as string),
    ).toBe(true)
  })

  it("classifies 401, a plain 403, a rate-limit 403 and a 429 as GitHub means them", async () => {
    const reset_ = String(Math.floor(Date.now() / 1000) + 5)
    const limited = await delivery()
    limited.server.answer("GET", /\/compare\//, {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset_ },
    })
    limited.server.answer("GET", /\/git\/trees\//, { status: 429, headers: { "retry-after": "7" } })
    expect((await limited.h.deliver()).state).toBe("delivered")
    expect(limited.h.waits[1]).toBe(7_000)
    await reset()

    const forbidden = await delivery()
    forbidden.server.answer("GET", /\/compare\//, {
      status: 403,
      body: { message: "Resource not accessible by integration" },
    })
    expect(await forbidden.h.deliver()).toMatchObject({ blockedReason: "delivery_unauthorized" })
  })

  it("refuses a mint narrower than delivery needs, an app not installed, and a mint GitHub refuses", async () => {
    const narrow = await delivery()
    narrow.server.granted = { contents: "read", pull_requests: "write", metadata: "read" }
    expect(await narrow.h.deliver()).toMatchObject({ blockedReason: "delivery_unauthorized" })
    expect(narrow.h.journal()).toContain("contents: write")
    await reset()

    const absent = await delivery()
    absent.server.installed = false
    expect(await absent.h.deliver()).toMatchObject({ blockedReason: "delivery_unauthorized" })
    expect(absent.h.journal()).toContain("not installed")
    await reset()

    // GitHub answers a mint wider than the installation with 422, and a gone installation 404.
    for (const status of [422, 404]) {
      const refused = await delivery()
      refused.server.answer("POST", /\/access_tokens$/, {
        status,
        body: {
          message:
            status === 422
              ? "The permissions requested are not granted to this installation."
              : "Not Found",
        },
      })
      expect(await refused.h.deliver(), String(status)).toMatchObject({
        blockedReason: "delivery_unauthorized",
      })
      expect(refused.h.journal()).toContain("the installation refused the token")
      await reset()
    }
  })

  it("accepts a write grant where delivery asks only to read", async () => {
    const { h, server } = await delivery()
    server.granted = {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      issues: "write",
    }
    expect((await h.deliver()).state, h.journal()).toBe("delivered")
  })

  it("refuses another app, an installation id that is not one, and a mint with no expiry", async () => {
    const other = await delivery()
    other.server.slug = "someone-elses-app"
    expect(await other.h.deliver()).toMatchObject({ blockedReason: "delivery_unauthorized" })
    expect(other.h.journal()).toContain("someone-elses-app[bot]")
    expect(other.server.requests.some((r) => r.path.startsWith("/users/"))).toBe(false)
    expect(other.server.tokens).toHaveLength(0)
    await reset()

    const odd = await delivery()
    odd.server.installationId = "42"
    expect(await odd.h.deliver()).toMatchObject({ blockedReason: "delivery_unconfirmed" })
    expect(odd.h.journal()).toContain("installation id")
    expect(odd.server.tokens).toHaveLength(0)
    await reset()

    const timeless = await delivery()
    timeless.server.answer("POST", /\/access_tokens$/, {
      status: 201,
      body: { token: "ghs_x", permissions: timeless.server.granted },
    })
    expect(await timeless.h.deliver()).toMatchObject({ blockedReason: "delivery_unconfirmed" })
    expect(timeless.h.journal()).toContain("expires_at")
  })

  it("refuses a repository GitHub names otherwise, even by case alone", async () => {
    for (const fullName of ["Cacheplane/B4run", "cacheplane/renamed"]) {
      const { h, server } = await delivery()
      server.answer("GET", /^\/repos\/cacheplane\/b4run$/, {
        status: 200,
        body: { id: 1, full_name: fullName, default_branch: "main" },
      })
      expect(await h.deliver(), fullName).toMatchObject({ blockedReason: "delivery_unauthorized" })
      expect(h.journal()).toContain(fullName)
      expect(server.repo.writes()).toEqual([])
      await reset()
    }
  })

  it("stops at an issue GitHub reads closed", async () => {
    const { h, server } = await delivery()
    server.repo.issues.set(912, "closed")
    expect(await h.deliver()).toMatchObject({ blockedReason: "delivery_issue_closed" })
  })

  it("reads a pull request's author, head repository, state, merge and draft from GitHub's JSON", async () => {
    // Another author.
    const authored = await delivery()
    authored.server.repo.author = "octocat"
    expect(await authored.h.deliver()).toMatchObject({ blockedReason: "delivery_branch_conflict" })
    expect(authored.h.journal()).toContain("its author is octocat")
    await reset()

    // A fork's head, and a head whose repository was deleted.
    for (const repo of [{ full_name: "someone/b4run", name: "b4run" }, null]) {
      const forked = await delivery()
      forked.server.pullShape = (p) => ({ ...p, head: { ...(p.head as object), repo } })
      expect(await forked.h.deliver()).toMatchObject({ blockedReason: "delivery_branch_conflict" })
      expect(forked.h.journal()).toContain(`its head is in ${repo?.full_name ?? "null"}`)
      await reset()
    }

    // A merged, and a closed, pull request already on the branch: never reopened.
    for (const merged of [true, false]) {
      const done = await delivery()
      done.server.repo.pulls.push({
        number: 7,
        url: `https://github.com/${REPOSITORY}/pull/7`,
        nodeId: "PR_7",
        state: "closed",
        draft: false,
        merged,
        author: "b4-factory[bot]",
        headRef: BRANCH,
        headRepository: REPOSITORY,
        headSha: "f".repeat(40),
        baseRef: "main",
      })
      expect(await done.h.deliver()).toMatchObject({ blockedReason: "delivery_branch_conflict" })
      expect(done.h.journal()).toContain(`#7 on ${BRANCH} was ${merged ? "merged" : "closed"}`)
      await reset()
    }

    // GitHub ignoring `draft: true`.
    const ready = await delivery()
    ready.server.repo.createReady = true
    expect(await ready.h.deliver()).toMatchObject({ blockedReason: "delivery_unconfirmed" })
    expect(ready.h.journal()).toContain("was created as ready, not draft")
    await reset()

    // A number that is not one.
    const numbered = await delivery()
    numbered.server.pullShape = (p) => ({ ...p, number: String(p.number) })
    expect(await numbered.h.deliver()).toMatchObject({ blockedReason: "delivery_unconfirmed" })
    expect(numbered.h.journal()).toContain("pull request number")
  })

  it("reads the issues a pull request would close, and refuses a query that answers errors or nothing", async () => {
    const closing = await delivery()
    closing.server.repo.closing = [912]
    expect(await closing.h.deliver()).toMatchObject({ blockedReason: "delivery_unconfirmed" })
    expect(closing.h.journal()).toContain("would close #912")
    await reset()

    const errors = await delivery()
    errors.server.answer("POST", /^\/graphql$/, {
      status: 200,
      body: {
        data: null,
        errors: [{ message: "Something went wrong while executing your query." }],
      },
    })
    expect(await errors.h.deliver()).toMatchObject({ blockedReason: "delivery_unconfirmed" })
    expect(errors.h.journal()).toContain("the closing-issues query answered errors")
    await reset()

    const missing = await delivery()
    missing.server.answer("POST", /^\/graphql$/, {
      status: 200,
      body: { data: { repository: { pullRequest: null } } },
    })
    expect(await missing.h.deliver()).toMatchObject({ blockedReason: "delivery_unconfirmed" })
    expect(missing.h.journal()).toContain("the closing-issues query found no pull request")
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
    const session = await adapter.open(REPOSITORY, new AbortController().signal)
    const tree = (server.repo.commits.get(h.pin) as { tree: string }).tree
    await expect(session.tree(tree)).rejects.toEqual(
      new DeliveryError("incomplete", `tree ${tree} was truncated`),
    )

    // In a delivery, the cause is named, not hashed into a guess, and the block is one
    // redeliver refuses: the pin's listing is as long tomorrow as it is today.
    server.answer("GET", /\/git\/trees\//, { status: 200, body: listed })
    const row = await h.deliver()
    expect(row).toMatchObject({ state: "blocked", blockedReason: "delivery_baseline_mismatch" })
    expect(REDELIVERABLE_BLOCKED_REASONS.has("delivery_baseline_mismatch")).toBe(false)
    expect(h.journal()).toContain("was truncated")
    expect(server.repo.writes()).toEqual([])
  })

  it("refuses an issue transferred (301) or deleted (410) since create as no longer open, never following the move", async () => {
    for (const [status, headers] of [
      [301, { location: "/repositories/99/issues/912" }],
      [410, {}],
    ] as const) {
      const { h, server, adapter } = await delivery()
      const answer = {
        status,
        headers,
        body: { message: status === 301 ? "Moved Permanently" : "This issue was deleted" },
      }
      server.answer("GET", /\/issues\/912$/, answer)
      const session = await adapter.open(REPOSITORY, new AbortController().signal)
      expect(await session.issueState(912)).toBe("gone")

      server.answer("GET", /\/issues\/912$/, answer)
      const row = await h.deliver()
      expect(row, h.journal()).toMatchObject({
        state: "blocked",
        blockedReason: "delivery_issue_closed",
      })
      expect(h.journal()).toContain(
        "transferred, deleted, or issues are disabled on the repository",
      )
      expect(server.requests.some((r) => r.path.includes("/repositories/99/"))).toBe(false)
      expect(server.repo.writes()).toEqual([])
      await reset()
    }
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
    // A bound far above a loopback round trip, so only the scripted delay ever reaches it.
    const { h, server } = await delivery({ requestTimeoutMs: 1_000 })
    server.answer("GET", /\/compare\//, { status: 200, delayMs: 5_000 })
    expect((await h.deliver()).state, h.journal()).toBe("delivered")
    expect(h.waits).toEqual([2_000])
    expect(h.journal()).toContain("no answer within 1000 ms")
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
