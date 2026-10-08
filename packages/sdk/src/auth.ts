/**
 * Authentication: the one place an app turns a request into a principal.
 *
 * `src/auth.ts` default-exports `defineAuth({ authenticate })`. The runtime
 * calls `authenticate` once per request, before middleware and before the
 * thread-access policy, and hands the result to every consumer as `principal`:
 * `MiddlewareRequest.principal`, `ThreadAccessRequest.principal`, and
 * `B4ToolContext.principal` for every tool the run calls. Nothing else in the
 * app needs to parse a header to learn who is calling.
 */

import type { RejectResult } from "./middleware.js"

/** What `authenticate` receives. */
export interface AuthRequest {
  /**
   * Lowercase keys, repeated headers joined with ", ". Compare with STRICT
   * EQUALITY: `X-User-Id: victim` plus `X-User-Id: attacker` arrives as the one
   * string `"victim, attacker"`, which `includes`/`startsWith`/`split(",")`
   * comparisons get wrong and `===` gets right.
   */
  readonly headers: Readonly<Record<string, string>>
  readonly method: string
  /** Path + query, e.g. `"/threads/t-1/runs/stream"`. */
  readonly url: string
}

/** The smallest principal: every principal has a string `id`. */
export interface B4PrincipalShape {
  readonly id: string
}

/**
 * Type registry the app's generated types augment. With a `src/auth.ts`,
 * `b4 typegen` declares `principal` here as the type its `authenticate`
 * resolves to, so `ctx.principal` in a tool is the app's own principal type.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated declarations
export interface B4Register {}

/** The app's principal type: from `B4Register` when typegen has declared it, else {@link B4PrincipalShape}. */
export type B4Principal = B4Register extends { readonly principal: infer P } ? P : B4PrincipalShape

/**
 * What `authenticate` may return: the principal, `undefined` for an anonymous
 * request, or `reject(...)` to answer the request before any endpoint runs.
 */
export type AuthResult<P extends B4PrincipalShape = B4PrincipalShape> = P | undefined | RejectResult

/** What `setup` receives. */
export interface AuthSetupContext {
  /** Absolute path of the app root the runtime was booted for. */
  readonly appRoot: string
}

export interface AuthDefinition<P extends B4PrincipalShape = B4PrincipalShape> {
  /**
   * Resolve the caller. Called once per request, for every runtime endpoint
   * except `/healthz`, `/readyz` and CORS preflight.
   *
   * - A principal (an object with a string `id`) is passed to every consumer.
   * - `undefined` makes the request anonymous: `principal` is `undefined`, and
   *   middleware, the thread-access policy and tools each decide what that
   *   means.
   * - `reject(status, body)` answers the request with that response.
   * - A throw, or a return that is none of these, fails the request with a
   *   500. It is never downgraded to anonymous.
   *
   * The principal is never persisted: it is not written to checkpoints, thread
   * metadata or run config, and a resumed run uses the resumer's principal. Keep
   * secrets out of it anyway.
   */
  readonly authenticate: (req: AuthRequest) => Promise<AuthResult<P>> | AuthResult<P>
  /**
   * Runs at most once per runtime, lazily, before the first request.
   * Concurrent first requests share one in-flight call, and a rejection fails
   * only the requests that awaited it and is retried by the next one. Same
   * semantics as `MiddlewareDefinition.setup`.
   */
  readonly setup?: (ctx: AuthSetupContext) => Promise<void> | void
  /** Runs once from the runtime's shutdown path, after a successful `setup`. */
  readonly dispose?: () => Promise<void> | void
}

/**
 * The brand `defineAuth` stamps on its result. Registered (`Symbol.for`) so a
 * runtime and an app that load different copies of this package still agree.
 */
const AUTH_BRAND = Symbol.for("b4run.auth")

/**
 * Declare the app's authentication. `src/auth.ts` must default-export the
 * result: a missing or plain-object default is a boot and build error, because
 * an `auth.ts` the runtime silently ignored would leave every endpoint open.
 */
export function defineAuth<P extends B4PrincipalShape>(
  definition: AuthDefinition<P>,
): AuthDefinition<P> {
  if (typeof definition?.authenticate !== "function") {
    throw new TypeError("defineAuth: `authenticate` must be a function")
  }
  return Object.freeze({ ...definition, [AUTH_BRAND]: true })
}

/** Whether `value` came from {@link defineAuth}. */
export function isAuthDefinition(value: unknown): value is AuthDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[AUTH_BRAND] === true &&
    typeof (value as { readonly authenticate?: unknown }).authenticate === "function"
  )
}
