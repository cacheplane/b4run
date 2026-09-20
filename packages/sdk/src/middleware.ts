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

/** One message of the conversation a run was started with, as the client sent it. */
export interface MiddlewareAfterMessage {
  readonly role: string
  readonly content: string
  readonly id?: string
}

/** What `after` receives: the finished run, before the client sees its final message. */
export interface MiddlewareAfterRun {
  readonly assistantId: string
  /** The context this request's `handle` returned through `allow(context)`, if any. */
  readonly context: Readonly<Record<string, unknown>> | undefined
  /**
   * The final assistant message: the text of the last assistant message the
   * run produced, concatenated from its streamed deltas. Empty when the run
   * ended without one (for example after a tool call the model never
   * followed up on).
   */
  readonly finalMessage: string
  /** The client-supplied conversation the run was started with. */
  readonly messages: readonly MiddlewareAfterMessage[]
  readonly routeId: string
  readonly runId: string
  readonly threadId: string
}

/** Replace the final assistant message. An empty string suppresses it. */
export interface ReplaceFinalMessageResult {
  readonly finalMessage: string
}

/**
 * What `after` may return: nothing to leave the final message as is, a
 * replacement, or {@link reject} to fail the run. A rejection's `body` (a
 * string, or an object with a string `message` or `error`) becomes the error
 * message the client sees; its HTTP `status` is recorded but cannot change
 * the response, which is already streaming.
 */
export type MiddlewareAfterResult = ReplaceFinalMessageResult | RejectResult | undefined

/** The final-message decision: see `MiddlewareDefinition.after`. */
export type MiddlewareAfterHook = (
  run: MiddlewareAfterRun,
) => Promise<MiddlewareAfterResult | void> | MiddlewareAfterResult | void

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
  /**
   * Runs once per AG-UI run (`POST /agui/:routeId`), after the agent's final
   * assistant message is known and before the client sees it: the final
   * message's `TEXT_MESSAGE_*` events and `RUN_FINISHED` are emitted only once
   * the hook has answered. It receives the context `handle` allowed for the
   * request, so validation that used to live in a tool can run on the model's
   * actual final message instead. Return nothing to keep the message, a
   * `{ finalMessage }` to replace it, or `reject(...)` to end the run with a
   * `RUN_ERROR` (code `middleware_rejected`). A thrown error also ends the run
   * with a `RUN_ERROR` carrying its message.
   *
   * The trade-off: with this hook defined, the final assistant message is
   * buffered on the server and delivered whole rather than token by token.
   * Text the model emits before a tool call still streams live, because a
   * tool call proves it was not the final message. A run that parks on a
   * human-in-the-loop interrupt does not run the hook; the resume that
   * completes it does.
   */
  readonly after?: MiddlewareAfterHook
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
