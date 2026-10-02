import { DeliveryError } from "../adapter.js"
import { FACTORY_BOT_LOGIN } from "../guard.js"

/**
 * The adapter's single request function (rung 4 spec §6.2). It accepts only the method and
 * path shapes below, for the one configured repository, and refuses everything else before a
 * socket opens: no PATCH, PUT or DELETE exists, a ref may be created only under
 * `refs/heads/factory/`, a pull request only as a draft against the configured base, and the
 * one GraphQL document is a fixed read. A bug elsewhere cannot point a write at another
 * repository or branch.
 */

export class DisallowedRequestError extends Error {
  constructor(method: string, path: string, why: string) {
    super(`refused ${method} ${path}: ${why}`)
    this.name = "DisallowedRequestError"
  }
}

/** The one GraphQL document: which issues merging the pull request would close. */
export const CLOSING_ISSUES_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:20){nodes{number}}}}}"

const SHA = "[0-9a-f]{40}"
const IS_SHA = new RegExp(`^${SHA}$`)
const FACTORY_REF = /^refs\/heads\/factory\/wo-[0-9a-f]{16}$/
const FACTORY_HEAD = /^factory\/wo-[0-9a-f]{16}$/

/** What delivery needs, and all a minted token may carry (spec §2 D2, §15 item 2). */
export const DELIVERY_PERMISSIONS: Readonly<Record<string, "read" | "write">> = Object.freeze({
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  issues: "read",
})

export type Auth = "jwt" | "token" | "none"

/** A body's problem, or `undefined` when it is exactly what this route may send. */
type BodyRule = (body: Record<string, unknown>, target: Target) => string | undefined

interface Route {
  readonly method: "GET" | "POST"
  /** Matched against the path after `/repos/<owner>/<name>` has been checked and removed. */
  readonly pattern: RegExp
  readonly auth: Auth
  readonly repository: boolean
  /** A POST's body rule: every POST has one, and every key it does not name is refused. */
  readonly body?: BodyRule
}

export interface Target {
  readonly repository: string
  readonly baseBranch: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The keys of `value`, exactly `keys` (in any order), or what differs. */
function exactKeys(value: unknown, keys: readonly string[], what: string): string | undefined {
  if (!isRecord(value)) return `${what} is not an object`
  const have = Object.keys(value).sort()
  const want = [...keys].sort()
  return have.length === want.length && have.every((k, i) => k === want[i])
    ? undefined
    : `${what} carries exactly ${want.join(", ")}, not ${have.join(", ")}`
}

/** The first problem among `checks`: each a problem or `undefined`, evaluated in order. */
const first = (...checks: (() => string | undefined)[]): string | undefined => {
  for (const check of checks) {
    const problem = check()
    if (problem !== undefined) return problem
  }
  return undefined
}
const must = (ok: () => boolean, problem: string) => () => (ok() ? undefined : problem)

const identityRule = (value: unknown, what: string) =>
  first(
    () => exactKeys(value, ["name", "email", "date"], what),
    () => {
      const v = value as Record<string, unknown>
      return [v.name, v.email, v.date].every((x) => typeof x === "string")
        ? undefined
        : `${what}'s fields are strings`
    },
  )

const refBody: BodyRule = (body) =>
  first(
    () => exactKeys(body, ["ref", "sha"], "a ref"),
    must(
      () => typeof body.ref === "string" && FACTORY_REF.test(body.ref),
      `a ref may be created only as refs/heads/factory/<work order>, not ${String(body.ref)}`,
    ),
    must(() => typeof body.sha === "string" && IS_SHA.test(body.sha), "a ref points at a sha"),
  )

const pullBody: BodyRule = (body, target) =>
  first(
    () =>
      exactKeys(
        body,
        "maintainer_can_modify" in body
          ? ["title", "body", "head", "base", "draft", "maintainer_can_modify"]
          : ["title", "body", "head", "base", "draft"],
        "a pull request",
      ),
    must(() => body.draft === true, "a pull request is created only as a draft"),
    must(
      () => !("maintainer_can_modify" in body) || body.maintainer_can_modify === false,
      "a pull request is created only with maintainer_can_modify false",
    ),
    must(() => body.base === target.baseBranch, `a pull request targets only ${target.baseBranch}`),
    must(
      () => typeof body.head === "string" && FACTORY_HEAD.test(body.head),
      "a pull request's head is only factory/<work order>",
    ),
    must(
      () => typeof body.title === "string" && typeof body.body === "string",
      "a pull request's title and body are strings",
    ),
  )

const mintBody: BodyRule = (body, target) => {
  const name = target.repository.split("/")[1] as string
  const repositories = body.repositories
  return first(
    must(
      () => Array.isArray(repositories) && repositories.length === 1 && repositories[0] === name,
      `a token is minted for only ${name}`,
    ),
    () => exactKeys(body, ["repositories", "permissions"], "a token request"),
    () => exactKeys(body.permissions, Object.keys(DELIVERY_PERMISSIONS), "a token's permissions"),
    must(
      () =>
        Object.entries(DELIVERY_PERMISSIONS).every(
          ([scope, level]) => (body.permissions as Record<string, unknown>)[scope] === level,
        ),
      "a token carries exactly the delivery permissions",
    ),
  )
}

const graphqlBody: BodyRule = (body, target) => {
  const [owner, name] = target.repository.split("/")
  const variables = body.variables as Record<string, unknown>
  return first(
    () => exactKeys(body, ["query", "variables"], "the GraphQL request"),
    must(() => body.query === CLOSING_ISSUES_QUERY, "only the closing-issues query is sent"),
    () => exactKeys(variables, ["owner", "name", "number"], "the query's variables"),
    must(
      () => variables.owner === owner && variables.name === name,
      `the query reads only ${target.repository}`,
    ),
    must(
      () => Number.isSafeInteger(variables.number) && (variables.number as number) > 0,
      "the query reads one pull request by number",
    ),
  )
}

const blobBody: BodyRule = (body) =>
  first(
    () => exactKeys(body, ["content", "encoding"], "a blob"),
    must(
      () => typeof body.content === "string" && body.encoding === "base64",
      "a blob is base64 content",
    ),
  )

const treeBody: BodyRule = (body) =>
  first(
    () => exactKeys(body, ["base_tree", "tree"], "a tree"),
    must(
      () => typeof body.base_tree === "string" && IS_SHA.test(body.base_tree),
      "a tree has a base",
    ),
    must(() => Array.isArray(body.tree), "a tree's entries are a list"),
    () => {
      for (const entry of body.tree as unknown[]) {
        const problem = first(
          () => exactKeys(entry, ["path", "mode", "type", "sha"], "a tree entry"),
          () => {
            const e = entry as Record<string, unknown>
            return typeof e.path === "string" &&
              e.path !== "" &&
              (e.mode === "100644" || e.mode === "100755") &&
              e.type === "blob" &&
              typeof e.sha === "string" &&
              IS_SHA.test(e.sha)
              ? undefined
              : "a tree entry is a regular file's blob"
          },
        )
        if (problem !== undefined) return problem
      }
      return undefined
    },
  )

const commitBody: BodyRule = (body) =>
  first(
    () => exactKeys(body, ["message", "tree", "parents", "author", "committer"], "a commit"),
    must(() => typeof body.message === "string", "a commit's message is a string"),
    must(() => typeof body.tree === "string" && IS_SHA.test(body.tree), "a commit names its tree"),
    must(
      () =>
        Array.isArray(body.parents) &&
        body.parents.every((p) => typeof p === "string" && IS_SHA.test(p)),
      "a commit's parents are shas",
    ),
    () => identityRule(body.author, "a commit's author"),
    () => identityRule(body.committer, "a commit's committer"),
  )

const ROUTES: readonly Route[] = [
  { method: "GET", pattern: /^\/app$/, auth: "jwt", repository: false },
  { method: "GET", pattern: /^\/installation$/, auth: "jwt", repository: true },
  {
    method: "POST",
    pattern: /^\/app\/installations\/\d+\/access_tokens$/,
    auth: "jwt",
    repository: false,
    body: mintBody,
  },
  { method: "GET", pattern: /^$/, auth: "token", repository: true },
  {
    method: "GET",
    pattern: /^\/users\/(?<login>[^/]+)$/,
    auth: "token",
    repository: false,
  },
  {
    method: "GET",
    pattern: /^\/rules\/branches\/[A-Za-z0-9._/-]+$/,
    auth: "token",
    repository: true,
  },
  { method: "GET", pattern: /^\/issues\/\d+$/, auth: "token", repository: true },
  {
    method: "GET",
    pattern: /^\/git\/ref\/heads\/[A-Za-z0-9._/-]+$/,
    auth: "token",
    repository: true,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/compare/${SHA}\\.\\.\\.${SHA}$`),
    auth: "token",
    repository: true,
  },
  { method: "GET", pattern: new RegExp(`^/git/commits/${SHA}$`), auth: "token", repository: true },
  { method: "GET", pattern: new RegExp(`^/git/trees/${SHA}$`), auth: "token", repository: true },
  { method: "POST", pattern: /^\/git\/blobs$/, auth: "token", repository: true, body: blobBody },
  { method: "POST", pattern: /^\/git\/trees$/, auth: "token", repository: true, body: treeBody },
  {
    method: "POST",
    pattern: /^\/git\/commits$/,
    auth: "token",
    repository: true,
    body: commitBody,
  },
  { method: "POST", pattern: /^\/git\/refs$/, auth: "token", repository: true, body: refBody },
  {
    method: "GET",
    pattern: /^\/pulls\?head=[^&#]+&state=all&per_page=100$/,
    auth: "token",
    repository: true,
  },
  { method: "POST", pattern: /^\/pulls$/, auth: "token", repository: true, body: pullBody },
  { method: "GET", pattern: /^\/pulls\/\d+$/, auth: "token", repository: true },
  { method: "POST", pattern: /^\/graphql$/, auth: "token", repository: false, body: graphqlBody },
]

/**
 * The route `method path` matches for `target`, or a `DisallowedRequestError`. Exported so a
 * test can sweep it with every method and many paths without a server.
 */
export function allowedRoute(method: string, path: string, body: unknown, target: Target): Route {
  // Before any pattern: `fetch` resolves `.` and `..` segments (and their %2e spellings) and
  // would send a checked path somewhere else (`…/heads/../../../other/x`), and an empty
  // segment is not a path GitHub names. The query is the pulls listing's, checked by its route.
  const pathname = path.split("?")[0] as string
  const segments = pathname.split("/").slice(1)
  if (
    !pathname.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    /%2e|%2f|%5c|\\/i.test(pathname)
  )
    throw new DisallowedRequestError(method, path, "a dot, empty or encoded separator segment")
  const prefix = `/repos/${target.repository}`
  const inRepository =
    path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)
  const rest = inRepository ? path.slice(prefix.length) : path
  if (path.startsWith("/repos/") && !inRepository)
    throw new DisallowedRequestError(method, path, `only ${target.repository} is addressed`)
  const route = ROUTES.find(
    (r) => r.method === method && r.repository === inRepository && r.pattern.test(rest),
  )
  if (route === undefined) throw new DisallowedRequestError(method, path, "not on the allow-list")
  const login = route.pattern.exec(rest)?.groups?.login
  if (login !== undefined) {
    let decoded: string
    try {
      decoded = decodeURIComponent(login)
    } catch {
      throw new DisallowedRequestError(method, path, "the login does not decode")
    }
    if (decoded !== FACTORY_BOT_LOGIN)
      throw new DisallowedRequestError(method, path, `only the factory's bot user is read`)
  }
  if (route.body === undefined) {
    if (body !== undefined) throw new DisallowedRequestError(method, path, "a GET carries no body")
  } else {
    const problem = isRecord(body) ? route.body(body, target) : "a body is required"
    if (problem !== undefined) throw new DisallowedRequestError(method, path, problem)
  }
  return route
}

/** How long a rate-limited response asks the caller to wait, in ms, if it says. */
function retryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const after = headers.get("retry-after")
  if (after !== null && /^\d+$/.test(after)) return Number(after) * 1000
  const reset = headers.get("x-ratelimit-reset")
  if (reset !== null && /^\d+$/.test(reset)) return Math.max(0, Number(reset) * 1000 - nowMs)
  return undefined
}

export interface RequestOptions {
  readonly fetch: typeof fetch
  readonly baseUrl: string
  readonly target: Target
  readonly credential: (auth: Auth) => string
  readonly signal: AbortSignal
  readonly now: () => number
  /** One request's bound (D25), body included; past it the request is transient, retried by the step. */
  readonly timeoutMs: number
  /** The largest body read; a larger one is unexpected. Default 10 MiB. */
  readonly maxBodyBytes?: number
}

const MAX_BODY_BYTES = 10 * 1024 * 1024
/** GitHub's secondary rate limit says so in its message and may not say how long to wait. */
const SECONDARY_LIMIT_WAIT_MS = 60_000

/**
 * The body serialized once: the string that will be sent, and the value it parses back to,
 * which is what the allow-list checks. A `toJSON`, a getter or a prototype can then never make
 * the bytes on the wire differ from the body that was checked.
 */
function asSent(
  method: string,
  path: string,
  body: unknown,
): { readonly text?: string; readonly value?: unknown } {
  if (body === undefined) return {}
  let text: string | undefined
  try {
    text = JSON.stringify(body)
  } catch {
    text = undefined
  }
  if (text === undefined)
    throw new DisallowedRequestError(method, path, "the body does not serialize as JSON")
  return { text, value: JSON.parse(text) }
}

/**
 * One allow-listed request. Returns the parsed JSON body of a 2xx; classifies every other
 * answer as a `DeliveryError` the worker knows how to treat (spec §6.5). The message carries
 * GitHub's own `message` field at most, never a header.
 */
export async function githubRequest(
  options: RequestOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly json: unknown }> {
  const sent = asSent(method, path, body)
  const route = allowedRoute(method, path, sent.value, options.target)
  // The URL fetch will send is the one checked: same origin, same path and query, nothing
  // normalised. Checked before any credential is made.
  const base = new URL(options.baseUrl)
  const url = new URL(`${options.baseUrl}${path}`)
  const query = path.includes("?") ? path.slice(path.indexOf("?")) : ""
  if (
    url.origin !== base.origin ||
    url.pathname !== `${base.pathname.replace(/\/$/, "")}${path.split("?")[0]}` ||
    url.search !== query ||
    url.hash !== "" ||
    base.search !== "" ||
    base.hash !== ""
  )
    throw new DisallowedRequestError(method, path, `it resolves to ${url.pathname}`)
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "b4-software-factory",
  }
  if (route.auth !== "none")
    headers.authorization = `${route.auth === "jwt" ? "Bearer" : "token"} ${options.credential(route.auth)}`
  if (sent.text !== undefined) headers["content-type"] = "application/json"
  // The controller closing is the caller's to see (the worker stops, D26); a timeout or a
  // network failure, before the answer or in the middle of its body, is transient.
  const failed = (error: unknown): never => {
    if (options.signal.aborted) throw error
    const timedOut = (error as Error).name === "TimeoutError"
    throw new DeliveryError(
      "transient",
      `${method} ${path}: ${timedOut ? `no answer within ${options.timeoutMs} ms` : (error as Error).message}`,
    )
  }
  let response: Response
  try {
    response = await options.fetch(url, {
      method,
      headers,
      ...(sent.text !== undefined ? { body: sent.text } : {}),
      // Never followed (D28): a redirect would send the request, and the token, to a URL the
      // allow-list never saw. A 3xx is answered below as unexpected.
      redirect: "manual",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
    })
  } catch (error) {
    return failed(error)
  }
  const status = response.status
  if (status >= 300 && status < 400) {
    await response.body?.cancel().catch(() => {})
    throw new DeliveryError(
      "unexpected",
      `${method} ${path}: HTTP ${status} redirect, not followed`,
      undefined,
      status,
    )
  }
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES
  const tooLarge = () =>
    new DeliveryError(
      "unexpected",
      `${method} ${path}: HTTP ${status} body of more than ${limit} bytes`,
      undefined,
      status,
    )
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (declared > limit) {
    await response.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  let text = ""
  if (response.body !== null) {
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) {
          await reader.cancel().catch(() => {})
          throw tooLarge()
        }
        chunks.push(value)
      }
    } catch (error) {
      if (error instanceof DeliveryError) throw error
      failed(error)
    }
    text = Buffer.concat(chunks).toString("utf8")
  }
  let json: unknown = null
  let parsed = true
  try {
    json = text === "" ? null : JSON.parse(text)
  } catch {
    parsed = false
  }
  if (status >= 200 && status < 300) {
    // Every allow-listed route answers JSON; a 204 alone is empty.
    if (!parsed || (text === "" && status !== 204))
      throw new DeliveryError(
        "unexpected",
        `${method} ${path}: HTTP ${status} answered no JSON`,
        undefined,
        status,
      )
    return { status, json }
  }
  const said = parsed ? (json as { message?: unknown } | null)?.message : undefined
  const message = `${method} ${path}: HTTP ${status}${typeof said === "string" ? ` ${said.slice(0, 300)}` : ""}`
  const wait = retryAfterMs(response.headers, options.now())
  if (status === 429) throw new DeliveryError("rate_limited", message, wait, status)
  if (status === 403) {
    const secondary = typeof said === "string" && /secondary rate limit/i.test(said)
    const limited =
      secondary ||
      response.headers.get("retry-after") !== null ||
      response.headers.get("x-ratelimit-remaining") === "0"
    throw new DeliveryError(
      limited ? "rate_limited" : "unauthorized",
      message,
      wait ?? (secondary ? SECONDARY_LIMIT_WAIT_MS : undefined),
      status,
    )
  }
  if (status === 401) throw new DeliveryError("unauthorized", message, undefined, status)
  if (status === 404) throw new DeliveryError("not_found", message, undefined, status)
  if (status === 409 || status === 422)
    throw new DeliveryError("conflict", message, undefined, status)
  if (status >= 500) throw new DeliveryError("transient", message, undefined, status)
  throw new DeliveryError("unexpected", message, undefined, status)
}
