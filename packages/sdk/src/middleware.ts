export interface MiddlewareRequest {
  /**
   * Detached snapshot of the original parsed JSON envelope on POST execution
   * requests. Client-supplied and untrusted, including any protocol extensions;
   * validate values before returning them through `allow(context)`. Mutating
   * this snapshot does not rewrite execution input. Absent on GET requests.
   */
  readonly body?: unknown
  readonly assistantId: string
  readonly headers: Readonly<Record<string, string>>
  readonly method: string
  readonly params: Readonly<Record<string, string>>
  readonly routeId: string
  readonly url: string
}

export interface ContinueResult {
  readonly action: "continue"
  readonly context?: Record<string, unknown>
}

export interface RejectResult {
  readonly action: "reject"
  readonly body?: unknown
  readonly status: number
}

export type MiddlewareResult = ContinueResult | RejectResult

/** The per-request decision: the function form of a middleware. */
export type MiddlewareHandler = (
  req: MiddlewareRequest,
) => Promise<MiddlewareResult> | MiddlewareResult

/** What `setup` receives. Deliberately small; see `MiddlewareDefinition.setup`. */
export interface MiddlewareSetupContext {
  /** Absolute path of the app root the runtime was booted for. */
  readonly appRoot: string
}

/**
 * The lifecycle form of a middleware: a `handle` plus optional `setup` and
 * `dispose` hooks for resources that outlive one request, such as a database
 * pool. Keep the resource in a module-scope variable; `setup` opens it and
 * `dispose` releases it.
 */
export interface MiddlewareDefinition {
  /**
   * Runs at most once per runtime, lazily, before the first request this
   * middleware gates. Concurrent first requests share one in-flight call. A
   * rejection fails only the request that awaited it and is retried by the
   * next one, so a transient outage never poisons the process. `handle` is
   * never called before `setup` has succeeded.
   */
  readonly setup?: (ctx: MiddlewareSetupContext) => Promise<void> | void
  /**
   * Runs once from the runtime's shutdown path (`SIGTERM`/`SIGINT` on the Node
   * targets), after in-flight requests have drained. Invoked when there is no
   * `setup`, or after a `setup` that completed successfully; never for a
   * `setup` that did not run or only ever failed. Edge/Hono builds have no
   * shutdown hook, so it is not invoked there.
   */
  readonly dispose?: () => Promise<void> | void
  /** The per-request decision. */
  readonly handle: MiddlewareHandler
}

/**
 * A middleware export: either the plain handler function or a
 * {@link MiddlewareDefinition} with lifecycle hooks.
 */
export type B4Middleware = MiddlewareHandler | MiddlewareDefinition

/**
 * Type-preserving identity: a plain handler stays a handler, a lifecycle
 * definition stays a definition. Exists for editor inference.
 */
export function defineMiddleware<T extends B4Middleware>(middleware: T): T {
  return middleware
}

export function reject(status: number, body?: unknown): RejectResult {
  if (body !== undefined) {
    return { action: "reject", body, status }
  }
  return { action: "reject", status }
}

export function allow(context?: Record<string, unknown>): ContinueResult {
  if (context) {
    return { action: "continue", context }
  }
  return { action: "continue" }
}
