/**
 * The LangSmith form of an app's `src/auth.ts`: `b4 build --target langsmith`
 * emits `.b4/build/auth.ts`, which calls this and is wired as `langgraph.json`
 * `auth.path`. LangGraph runs it as its own auth layer.
 *
 * What maps, and how:
 * - `authenticate` runs once per request. A principal becomes the LangGraph user
 *   (`identity` is its `id`; the principal rides along as `b4_principal`, which
 *   tools read back as `ctx.principal`). `reject(status, body)` becomes that
 *   HTTP status. `undefined` becomes 401: LangGraph has no anonymous user. A
 *   throw, or a malformed result, is a 500.
 * - `ownedThreads` compiles to metadata-filter handlers. Every other thread
 *   policy is refused at build time: LangGraph handlers never see the stored
 *   row, so arbitrary policy code cannot run there.
 * - `setup` runs once, lazily, before the first request; there is no hook for
 *   `dispose` on this target.
 *
 * The principal is stored in the run's config on LangSmith (LangGraph keeps
 * `langgraph_auth_user` there), so it must carry no secrets.
 */

import {
  type AuthDefinition,
  isAuthDefinition,
  type OwnedThreadsOptions,
  ownedThreadsOptions,
  type ThreadAccessPolicy,
} from "@b4run/sdk"

/**
 * The two classes this needs from `@langchain/langgraph-sdk/auth`. Passed in by
 * the emitted `.b4/build/auth.ts`, which imports them from the copy the
 * LangGraph server itself resolves — so the server recognizes the `Auth` it
 * loads and the `HTTPException`s it catches, and B4.run packages take no
 * dependency on the SDK.
 */
export interface LangGraphAuthClasses<A extends LangGraphAuthLike> {
  readonly Auth: new () => A
  readonly HTTPException: new (status: number, options?: { message?: string }) => Error
}

/** The part of LangGraph's `Auth` builder this uses. */
export interface LangGraphAuthLike {
  authenticate(callback: (request: Request) => Promise<unknown>): this
  on(
    event: string | readonly string[],
    callback: (args: { user: unknown; value: unknown }) => unknown,
  ): this
}

/** The thread metadata key an `ownedThreads` policy stamps and filters on, on LangSmith. */
export const LANGSMITH_OWNER_KEY = "b4:owner"

interface LangSmithUser {
  readonly identity: string
  readonly b4_principal?: { readonly id: string }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

function isReject(value: unknown): value is { action: "reject"; status: number; body?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { action?: unknown }).action === "reject" &&
    typeof (value as { status?: unknown }).status === "number"
  )
}

/** Build the LangGraph `Auth` for an app's `src/auth.ts` and, optionally, its `ownedThreads` policy. */
export function createLangSmithAuth<A extends LangGraphAuthLike>(
  options: LangGraphAuthClasses<A> & {
    readonly auth: unknown
    readonly threadAccess?: unknown
  },
): A {
  const { Auth, HTTPException } = options
  if (!isAuthDefinition(options.auth)) {
    throw new Error("src/auth.ts must default-export `defineAuth(...)` (B4_E3005).")
  }
  const app: AuthDefinition = options.auth
  let owned: OwnedThreadsOptions | undefined
  if (options.threadAccess !== undefined) {
    owned = ownedThreadsOptions(options.threadAccess as ThreadAccessPolicy)
    if (owned === undefined) {
      throw new Error(
        "On LangSmith, src/thread-access.ts must default-export `ownedThreads(...)`: other policies " +
          "cannot run there (B4_E1005).",
      )
    }
  }

  let setup: Promise<void> | undefined
  const ensureSetup = (): Promise<void> => {
    if (!app.setup) return Promise.resolve()
    setup ??= Promise.resolve()
      .then(() => app.setup?.({ appRoot: process.cwd() }))
      .catch((error: unknown) => {
        setup = undefined
        throw error
      })
    return setup
  }

  const langgraph = new Auth().authenticate(async (request: Request) => {
    await ensureSetup()
    const url = new URL(request.url)
    const result: unknown = await app.authenticate({
      headers: headersToRecord(request.headers),
      method: request.method,
      url: `${url.pathname}${url.search}`,
    })
    if (isReject(result)) {
      throw new HTTPException(result.status, {
        message: typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? {}),
      })
    }
    if (result === undefined) {
      // LangGraph has no anonymous user: an anonymous request is refused here.
      throw new HTTPException(401, { message: JSON.stringify({ error: "unauthorized" }) })
    }
    if (
      typeof result !== "object" ||
      result === null ||
      typeof (result as { id?: unknown }).id !== "string"
    ) {
      throw new Error("src/auth.ts authenticate() returned a principal without a string `id`.")
    }
    const principal = result as { readonly id: string }
    return { identity: principal.id, permissions: [], b4_principal: principal }
  })

  if (owned) {
    const ownerOptions = owned
    const ownerOf = (user: LangSmithUser): string => {
      const principal = user.b4_principal ?? { id: user.identity }
      return ownerOptions.owner ? ownerOptions.owner(principal) : principal.id
    }
    langgraph
      // Create stamps the owner, overwriting whatever the client put there.
      .on("threads:create", ({ user, value }) => {
        const created = value as { metadata?: Record<string, unknown> }
        created.metadata ??= {}
        created.metadata[LANGSMITH_OWNER_KEY] = ownerOf(user as LangSmithUser)
      })
      // An update may not touch the owner stamp, and only reaches the owner's threads.
      .on("threads:update", ({ user, value }) => {
        const metadata = (value as { metadata?: Record<string, unknown> }).metadata
        if (metadata !== undefined && LANGSMITH_OWNER_KEY in metadata) return false
        return { [LANGSMITH_OWNER_KEY]: ownerOf(user as LangSmithUser) }
      })
      // A filter: anyone else's thread reads as not found.
      .on(
        ["threads:read", "threads:delete", "threads:search", "threads:create_run"] as const,
        ({ user }) => ({ [LANGSMITH_OWNER_KEY]: ownerOf(user as LangSmithUser) }),
      )
      // LangGraph SDK clients list assistants; leave that open.
      .on(["assistants:read", "assistants:search"] as const, () => true)
      // The deny-by-default floor, like a thread policy's required `fallback`.
      .on("*", () => false)
  }
  return langgraph
}
