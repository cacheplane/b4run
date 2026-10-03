import type { IncomingMessage } from "node:http"
import type {
  B4Middleware,
  MiddlewareAfterHook,
  MiddlewareDefinition,
  MiddlewareHandler,
  MiddlewareRequest,
  MiddlewareResult,
  MiddlewareSetupContext,
} from "@b4run/sdk"

/**
 * Select the middleware function from a module namespace: the `default`
 * export when present (nullish falls through), else the named `middleware`
 * export; undefined when neither resolves to a function. The ONE selection
 * rule, shared by the dynamic probe (`loadMiddleware`, in `middleware-node.ts`)
 * and the static manifest's `normalizeMiddlewareModule` — built apps can never
 * bind differently than dev.
 */
export function selectMiddlewareExport(mod: unknown): B4Middleware | undefined {
  if (!mod || typeof mod !== "object") return undefined
  const candidate = mod as { readonly default?: unknown; readonly middleware?: unknown }
  const exported = candidate.default ?? candidate.middleware
  if (typeof exported === "function") return exported as MiddlewareHandler
  return isMiddlewareDefinition(exported) ? exported : undefined
}

/** The lifecycle object form: anything with a `handle` function. */
function isMiddlewareDefinition(value: unknown): value is MiddlewareDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly handle?: unknown }).handle === "function"
  )
}

/** A middleware bound to one runtime: its handler, and the shutdown hook the runtime owns. */
export interface BoundMiddleware {
  /**
   * The per-request handler, with the lazy `setup` folded in. `undefined` when
   * the app has no middleware. This is the ONLY shape `runMiddleware` accepts,
   * so a definition cannot reach a request without its `setup`.
   */
  readonly handler: MiddlewareHandler | undefined
  /**
   * The final-message hook, with the same lazy `setup` folded in. `undefined`
   * for a plain function and for a definition without one — the AG-UI handler
   * then leaves the run stream untouched. See `MiddlewareDefinition.after`.
   */
  readonly after: MiddlewareAfterHook | undefined
  /** Idempotent; see `MiddlewareDefinition.dispose` for when the hook runs. */
  readonly dispose: () => Promise<void>
}

const NO_DISPOSE = (): Promise<void> => Promise.resolve()

/**
 * Bind a middleware export to one runtime. A plain function is returned as
 * itself. A lifecycle definition becomes a handler that runs `setup` once,
 * lazily, single-flight, and retries it after a rejection; `dispose` is wired
 * for the runtime's shutdown path. Pure and edge-safe: the fetch core imports
 * this module.
 */
export function bindMiddleware(
  middleware: B4Middleware | undefined,
  ctx: MiddlewareSetupContext,
): BoundMiddleware {
  if (!middleware) return { after: undefined, dispose: NO_DISPOSE, handler: undefined }
  if (typeof middleware === "function") {
    return { after: undefined, dispose: NO_DISPOSE, handler: middleware }
  }

  const { after, dispose, handle, setup } = middleware
  /** The single in-flight or completed setup; cleared on rejection so the next request retries. */
  let setupPromise: Promise<void> | undefined
  let setupSucceeded = setup === undefined
  let disposing: Promise<void> | undefined

  const ensureSetup = (): Promise<void> => {
    if (disposing) return Promise.reject(new Error("Middleware has been disposed"))
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

  const handler: MiddlewareHandler = async (req) => {
    await ensureSetup()
    return await handle(req)
  }

  // `handle` has always run (and so `setup` has succeeded) by the time a run
  // finishes, so this await is normally a no-op; it exists so the hook can
  // never observe a disposed or never-set-up middleware.
  const boundAfter: MiddlewareAfterHook | undefined = after
    ? async (run) => {
        await ensureSetup()
        return await after(run)
      }
    : undefined

  const performDispose = async (): Promise<void> => {
    // An in-flight setup may still be opening the resource: wait for it to
    // settle (a failure means there is nothing to release) before deciding.
    if (setupPromise) await setupPromise.catch(() => undefined)
    if (!setupSucceeded || !dispose) return
    await dispose()
  }

  return {
    after: boundAfter,
    dispose: () => {
      disposing ??= performDispose()
      return disposing
    },
    handler,
  }
}

/**
 * The four middleware candidate paths, in probe precedence order — the ONE
 * list shared by the dynamic probe (`loadMiddleware`, in `middleware-node.ts`)
 * and the node target's build probe (`nodeTarget.emit`), so the static build
 * can never bind a different file than dev would.
 */
export function middlewareCandidatePaths(appRoot: string): readonly string[] {
  return [
    `${appRoot}/src/middleware.ts`,
    `${appRoot}/src/middleware.js`,
    `${appRoot}/middleware.ts`,
    `${appRoot}/middleware.js`,
  ]
}

/**
 * Run middleware. Returns continue (with optional context) or reject.
 */
export async function runMiddleware(
  middleware: MiddlewareHandler | undefined,
  request: MiddlewareRequest,
): Promise<MiddlewareResult> {
  if (!middleware) {
    return { action: "continue" }
  }

  return await middleware(request)
}

/** Flatten a web `Headers` object into a string map for MiddlewareRequest. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  // `Headers` iteration yields each `set-cookie` value as a separate entry, so
  // the loop above would keep only the last one. The pre-refactor Node path
  // (`parseHeaders`) joined repeated headers with ", " — preserve that shape.
  const setCookie = headers.getSetCookie?.() ?? []
  if (setCookie.length > 1) {
    record["set-cookie"] = setCookie.join(", ")
  }
  return record
}

/** Flatten an IncomingMessage's headers into a string map for MiddlewareRequest. */
export function parseHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers[key] = value
    } else if (Array.isArray(value)) {
      headers[key] = value.join(", ")
    }
  }
  return headers
}

/** Pull `[param]` route-param values out of the run input, for MiddlewareRequest.params. */
export function extractRouteParams(routeId: string, input: unknown): Record<string, string> {
  const params: Record<string, string> = {}
  const matches = routeId.matchAll(/\[(\w+)\]/g)
  const inputRecord = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >

  for (const match of matches) {
    const name = match[1]
    if (name && name in inputRecord) {
      params[name] = String(inputRecord[name])
    }
  }

  return params
}
