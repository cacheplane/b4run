/**
 * The app's authentication (`src/auth.ts`, `defineAuth`): the one resolver
 * that turns a request into a principal. Pure and edge-safe — the fetch core
 * imports this module, so the disk probe and dynamic import live in
 * `auth-node.ts`, the same split as `middleware.ts` / `middleware-node.ts`.
 *
 * The runtime resolves the principal once per request, before any gate, and
 * every consumer (middleware, the thread-access policy, tools) reads the same
 * value from {@link requestPrincipal}. No consumer parses a header for
 * identity.
 */

import {
  type AuthDefinition,
  type AuthSetupContext,
  type B4Principal,
  isAuthDefinition,
  type RejectResult,
} from "@b4run/sdk"

import { headersToRecord } from "./middleware.js"

/**
 * The auth file's candidate paths, in probe precedence order: the ONE list
 * shared by the dynamic probe (`loadAuth`) and the build targets, so a built
 * app can never bind a different file than dev does.
 */
export function authCandidatePaths(appRoot: string): readonly string[] {
  return [`${appRoot}/src/auth.ts`, `${appRoot}/src/auth.js`]
}

/**
 * Why `mod` (the auth file's module namespace) binds no valid auth, or
 * undefined when its default export came from `defineAuth`. The ONE rule,
 * shared by the dynamic probe and the static manifest. Unlike middleware there
 * is no "binds nothing, ignore it" case: an `auth.ts` the runtime ignored would
 * leave every endpoint anonymous, so a missing or plain default fails the boot.
 */
export function authExportError(mod: unknown): string | undefined {
  const exported =
    typeof mod === "object" && mod !== null
      ? (mod as { readonly default?: unknown }).default
      : undefined
  if (exported === undefined || exported === null) {
    return "it has no default export. Export it with `export default defineAuth({ authenticate })`"
  }
  if (!isAuthDefinition(exported)) {
    return "its default export did not come from `defineAuth`. Wrap it: `export default defineAuth({ authenticate })`"
  }
  return undefined
}

/** A malformed `authenticate` result. A 500, never an anonymous request. */
export class AuthResultError extends Error {
  readonly code = "B4_E3005"
  constructor(detail: string) {
    super(
      `src/auth.ts authenticate() returned ${detail}. Return a principal (an object with a string ` +
        "`id`), `undefined` for an anonymous request, or `reject(status, body)`.",
    )
    this.name = "AuthResultError"
  }
}

/** What one request resolved to. */
export type AuthOutcome =
  | { readonly kind: "principal"; readonly principal: B4Principal }
  | { readonly kind: "anonymous" }
  | { readonly kind: "reject"; readonly status: number; readonly body: unknown }

function isRejectResult(value: unknown): value is RejectResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly action?: unknown }).action === "reject" &&
    typeof (value as { readonly status?: unknown }).status === "number"
  )
}

/** Classify what `authenticate` returned. Throws {@link AuthResultError} on anything else. */
export function classifyAuthResult(result: unknown): AuthOutcome {
  if (result === undefined) return { kind: "anonymous" }
  if (isRejectResult(result)) return { kind: "reject", status: result.status, body: result.body }
  if (typeof result !== "object" || result === null) {
    throw new AuthResultError(result === null ? "null" : `a ${typeof result}`)
  }
  if (typeof (result as { readonly id?: unknown }).id !== "string") {
    throw new AuthResultError("an object without a string `id`")
  }
  // Shallow-frozen so no consumer can rewrite who the caller is for the next one.
  return { kind: "principal", principal: Object.freeze({ ...result }) as B4Principal }
}

/** An auth definition bound to one runtime. */
export interface BoundAuth {
  /** Resolve `request`. `undefined` when the app has no auth file: every request is anonymous. */
  readonly resolve: ((request: Request) => Promise<AuthOutcome>) | undefined
  /** Idempotent; runs `dispose` after a successful `setup`, as middleware does. */
  readonly dispose: () => Promise<void>
}

/**
 * Bind an auth definition to one runtime: `setup` runs once, lazily,
 * single-flight, and is retried after a rejection, exactly like
 * `bindMiddleware`.
 */
export function bindAuth(auth: AuthDefinition | undefined, ctx: AuthSetupContext): BoundAuth {
  if (!auth) return { dispose: () => Promise.resolve(), resolve: undefined }
  const { authenticate, dispose, setup } = auth
  let setupPromise: Promise<void> | undefined
  let setupSucceeded = setup === undefined
  let disposing: Promise<void> | undefined

  const ensureSetup = (): Promise<void> => {
    if (disposing) return Promise.reject(new Error("Auth has been disposed"))
    if (!setup) return Promise.resolve()
    setupPromise ??= Promise.resolve()
      .then(() => setup(ctx))
      .then(
        () => {
          setupSucceeded = true
        },
        (error: unknown) => {
          setupPromise = undefined
          throw error
        },
      )
    return setupPromise
  }

  const resolve = async (request: Request): Promise<AuthOutcome> => {
    await ensureSetup()
    const url = new URL(request.url)
    return classifyAuthResult(
      await authenticate({
        headers: headersToRecord(request.headers),
        method: request.method,
        url: `${url.pathname}${url.search}`,
      }),
    )
  }

  const performDispose = async (): Promise<void> => {
    if (setupPromise) await setupPromise.catch(() => undefined)
    if (!setupSucceeded || !dispose) return
    await dispose()
  }

  return {
    dispose: () => {
      disposing ??= performDispose()
      return disposing
    },
    resolve,
  }
}

/**
 * The principal each in-flight request resolved to. Keyed on the `Request` the
 * runtime received, so every gate on that request — middleware first or thread
 * access first, and the attach endpoint's per-route middleware — reads the one
 * value resolved for it, and nothing resolves twice.
 */
const principals = new WeakMap<Request, B4Principal | undefined>()

export function setRequestPrincipal(request: Request, principal: B4Principal | undefined): void {
  principals.set(request, principal)
}

/** The principal resolved for `request`; `undefined` for an anonymous request or an app with no auth file. */
export function requestPrincipal(request: Request): B4Principal | undefined {
  return principals.get(request)
}

/** The boot line naming the app's auth, logged once like the thread-access line. */
export function authBootLine(bound: boolean): string {
  return bound
    ? "B4.run: authentication bound from src/auth.ts; every request resolves its principal first."
    : "B4.run: no src/auth.ts; every request is anonymous (principal is undefined)."
}

/** `{ principal }` for a request that resolved one, else `{}` — for spreading into run options. */
export function withPrincipal(request: Request): { readonly principal?: B4Principal } {
  const principal = principals.get(request)
  return principal ? { principal } : {}
}

/** `{ consumedBy }` for a request that resolved a principal, else `{}` — what a consumed approval grant records. */
export function consumedByOf(request: Request): { readonly consumedBy?: string } {
  const principal = principals.get(request)
  return principal ? { consumedBy: principal.id } : {}
}
