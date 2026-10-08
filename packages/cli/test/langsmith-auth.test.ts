import { defineAuth, defineThreadAccess, ownedThreads, permit, reject } from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import { createLangSmithAuth, LANGSMITH_OWNER_KEY } from "../src/lib/runtime/langsmith-auth.js"

/** `@langchain/langgraph-sdk/auth`'s `Auth`, member for member: a handler registry. */
class Auth {
  "~handlerCache": {
    authenticate?: (request: Request) => Promise<unknown>
    callbacks?: Record<string, (args: { user: unknown; value: unknown }) => unknown>
  } = {}
  authenticate(cb: (request: Request) => Promise<unknown>): this {
    this["~handlerCache"].authenticate = cb
    return this
  }
  on(
    event: string | readonly string[],
    cb: (args: { user: unknown; value: unknown }) => unknown,
  ): this {
    this["~handlerCache"].callbacks ??= {}
    for (const name of typeof event === "string" ? [event] : event)
      this["~handlerCache"].callbacks[name] = cb
    return this
  }
}

class HTTPException extends Error {
  constructor(
    readonly status: number,
    options?: { message?: string },
  ) {
    super(options?.message)
  }
}

const userAuth = defineAuth({
  authenticate: ({ headers }) =>
    headers.authorization === undefined
      ? undefined
      : headers.authorization === "Bearer bad"
        ? reject(403, { error: "forbidden" })
        : { id: headers.authorization.slice("Bearer ".length), org: "acme" },
})

const build = (threadAccess?: unknown) =>
  createLangSmithAuth({
    Auth,
    HTTPException,
    auth: userAuth,
    ...(threadAccess ? { threadAccess } : {}),
  })

const authenticate = (auth: Auth, headers: Record<string, string>) =>
  auth["~handlerCache"].authenticate?.(new Request("https://graph.test/threads", { headers })) ??
  Promise.reject(new Error("no authenticate"))

describe("createLangSmithAuth: authenticate", () => {
  it("turns a principal into the LangGraph user, carrying the principal for tools", async () => {
    expect(await authenticate(build(), { authorization: "Bearer alice" })).toEqual({
      identity: "alice",
      permissions: [],
      b4_principal: { id: "alice", org: "acme" },
    })
  })

  it("maps reject to its status, and an anonymous request to 401", async () => {
    await expect(authenticate(build(), { authorization: "Bearer bad" })).rejects.toMatchObject({
      status: 403,
      message: JSON.stringify({ error: "forbidden" }),
    })
    await expect(authenticate(build(), {})).rejects.toMatchObject({ status: 401 })
  })

  it("fails a malformed principal as a plain error (a 500), never as a user", async () => {
    const auth = createLangSmithAuth({
      Auth,
      HTTPException,
      auth: defineAuth({ authenticate: () => ({ id: 7 }) as never }),
    })
    const error = await authenticate(auth, {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(HTTPException)
  })

  it("runs setup once, before the first request", async () => {
    let setups = 0
    const auth = createLangSmithAuth({
      Auth,
      HTTPException,
      auth: defineAuth({
        authenticate: () => ({ id: "u" }),
        setup: () => {
          setups++
        },
      }),
    })
    await Promise.all([authenticate(auth, {}), authenticate(auth, {})])
    await authenticate(auth, {})
    expect(setups).toBe(1)
  })

  it("registers no thread handlers without a policy", () => {
    expect(build()["~handlerCache"].callbacks).toBeUndefined()
  })
})

describe("createLangSmithAuth: ownedThreads", () => {
  const user = (id: string) => ({ identity: id, b4_principal: { id, org: "acme" } })
  const handler = (auth: Auth, event: string) => {
    const callback = auth["~handlerCache"].callbacks?.[event]
    if (!callback) throw new Error(`no handler for ${event}`)
    return callback
  }

  it("stamps a created thread with its owner, overwriting a forged stamp", () => {
    const auth = build(ownedThreads())
    const value = { metadata: { [LANGSMITH_OWNER_KEY]: "bob", other: 1 } }
    handler(auth, "threads:create")({ user: user("alice"), value })
    expect(value.metadata).toEqual({ [LANGSMITH_OWNER_KEY]: "alice", other: 1 })
  })

  it("filters reads, runs, searches and deletes to the caller's threads", () => {
    const auth = build(ownedThreads())
    for (const event of [
      "threads:read",
      "threads:delete",
      "threads:search",
      "threads:create_run",
    ]) {
      expect(handler(auth, event)({ user: user("alice"), value: {} })).toEqual({
        [LANGSMITH_OWNER_KEY]: "alice",
      })
    }
  })

  it("refuses an update that touches the owner stamp, and filters the rest", () => {
    const auth = build(ownedThreads())
    const update = handler(auth, "threads:update")
    expect(
      update({ user: user("alice"), value: { metadata: { [LANGSMITH_OWNER_KEY]: "bob" } } }),
    ).toBe(false)
    expect(update({ user: user("alice"), value: { metadata: { title: "x" } } })).toEqual({
      [LANGSMITH_OWNER_KEY]: "alice",
    })
  })

  it("stamps the policy's own owner id", () => {
    const auth = build(ownedThreads<{ id: string; org: string }>({ owner: (p) => p.org }))
    expect(handler(auth, "threads:read")({ user: user("alice"), value: {} })).toEqual({
      [LANGSMITH_OWNER_KEY]: "acme",
    })
  })

  it("leaves assistants open and denies everything else by default", () => {
    const auth = build(ownedThreads())
    expect(handler(auth, "assistants:search")({ user: user("alice"), value: {} })).toBe(true)
    expect(handler(auth, "*")({ user: user("alice"), value: {} })).toBe(false)
  })

  it("refuses a hand-written policy, and an auth file that is not defineAuth", () => {
    expect(() => build(defineThreadAccess({ fallback: () => permit() }))).toThrow(/ownedThreads/)
    expect(() =>
      createLangSmithAuth({ Auth, HTTPException, auth: { authenticate: () => undefined } }),
    ).toThrow(/defineAuth/)
  })
})
