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
const FACTORY_REF = /^refs\/heads\/factory\/wo-[0-9a-f]{16}$/
const FACTORY_HEAD = /^factory\/wo-[0-9a-f]{16}$/

export type Auth = "jwt" | "token" | "none"

interface Route {
  readonly method: "GET" | "POST"
  /** Matched against the path after `/repos/<owner>/<name>` has been checked and removed. */
  readonly pattern: RegExp
  readonly auth: Auth
  readonly repository: boolean
  /** A POST body's own rule, beyond its shape. */
  readonly body?: (body: Record<string, unknown>, target: Target) => string | undefined
}

export interface Target {
  readonly repository: string
  readonly baseBranch: string
}

const ROUTES: readonly Route[] = [
  { method: "GET", pattern: /^\/app$/, auth: "jwt", repository: false },
  { method: "GET", pattern: /^\/installation$/, auth: "jwt", repository: true },
  {
    method: "POST",
    pattern: /^\/app\/installations\/\d+\/access_tokens$/,
    auth: "jwt",
    repository: false,
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
  { method: "POST", pattern: /^\/git\/blobs$/, auth: "token", repository: true },
  { method: "POST", pattern: /^\/git\/trees$/, auth: "token", repository: true },
  { method: "POST", pattern: /^\/git\/commits$/, auth: "token", repository: true },
  {
    method: "POST",
    pattern: /^\/git\/refs$/,
    auth: "token",
    repository: true,
    body: (body) =>
      typeof body.ref === "string" && FACTORY_REF.test(body.ref)
        ? undefined
        : `a ref may be created only as refs/heads/factory/<work order>, not ${String(body.ref)}`,
  },
  {
    method: "GET",
    pattern: /^\/pulls\?head=[^&]+&state=all&per_page=100$/,
    auth: "token",
    repository: true,
  },
  {
    method: "POST",
    pattern: /^\/pulls$/,
    auth: "token",
    repository: true,
    body: (body, target) =>
      body.draft !== true
        ? "a pull request is created only as a draft"
        : body.base !== target.baseBranch
          ? `a pull request targets only ${target.baseBranch}`
          : typeof body.head !== "string" || !FACTORY_HEAD.test(body.head)
            ? "a pull request's head is only factory/<work order>"
            : undefined,
  },
  { method: "GET", pattern: /^\/pulls\/\d+$/, auth: "token", repository: true },
  {
    method: "POST",
    pattern: /^\/graphql$/,
    auth: "token",
    repository: false,
    body: (body) =>
      body.query === CLOSING_ISSUES_QUERY ? undefined : "only the closing-issues query is sent",
  },
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
  if (login !== undefined && decodeURIComponent(login) !== FACTORY_BOT_LOGIN)
    throw new DisallowedRequestError(method, path, `only the factory's bot user is read`)
  if (route.body !== undefined) {
    const problem =
      typeof body === "object" && body !== null
        ? route.body(body as Record<string, unknown>, target)
        : "a body is required"
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
  /** One request's bound (D25); past it the request is a transient failure, retried by the step. */
  readonly timeoutMs: number
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
  const route = allowedRoute(method, path, body, options.target)
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "b4-software-factory",
  }
  if (route.auth !== "none")
    headers.authorization = `${route.auth === "jwt" ? "Bearer" : "token"} ${options.credential(route.auth)}`
  if (body !== undefined) headers["content-type"] = "application/json"
  // The URL fetch will send is the one checked: same origin, same path, nothing normalised.
  const base = new URL(options.baseUrl)
  const url = new URL(`${options.baseUrl}${path}`)
  if (
    url.origin !== base.origin ||
    url.pathname !== `${base.pathname.replace(/\/$/, "")}${path.split("?")[0]}`
  )
    throw new DisallowedRequestError(method, path, `it resolves to ${url.pathname}`)
  let response: Response
  try {
    response = await options.fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // Never followed (D28): a redirect would send the request, and the token, to a URL the
      // allow-list never saw. A 3xx is answered below as unexpected.
      redirect: "manual",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
    })
  } catch (error) {
    // The controller closing is the caller's to see (the worker stops, D26); a timeout or a
    // network failure is transient.
    if (options.signal.aborted) throw error
    const timedOut = (error as Error).name === "TimeoutError"
    throw new DeliveryError(
      "transient",
      `${method} ${path}: ${timedOut ? `no answer within ${options.timeoutMs} ms` : (error as Error).message}`,
    )
  }
  if (response.status >= 300 && response.status < 400)
    throw new DeliveryError(
      "unexpected",
      `${method} ${path}: HTTP ${response.status} redirect, not followed`,
      undefined,
      response.status,
    )
  const text = await response.text()
  let json: unknown = null
  try {
    json = text === "" ? null : JSON.parse(text)
  } catch {
    json = null
  }
  const status = response.status
  if (status >= 200 && status < 300) return { status, json }
  const said = (json as { message?: unknown } | null)?.message
  const message = `${method} ${path}: HTTP ${status}${typeof said === "string" ? ` ${said.slice(0, 300)}` : ""}`
  const wait = retryAfterMs(response.headers, options.now())
  if (status === 429) throw new DeliveryError("rate_limited", message, wait, status)
  if (status === 403) {
    const limited =
      response.headers.get("retry-after") !== null ||
      response.headers.get("x-ratelimit-remaining") === "0"
    throw new DeliveryError(limited ? "rate_limited" : "unauthorized", message, wait, status)
  }
  if (status === 401) throw new DeliveryError("unauthorized", message, undefined, status)
  if (status === 404) throw new DeliveryError("not_found", message, undefined, status)
  if (status === 409 || status === 422)
    throw new DeliveryError("conflict", message, undefined, status)
  if (status >= 500) throw new DeliveryError("transient", message, undefined, status)
  throw new DeliveryError("unexpected", message, undefined, status)
}
