import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { isRuntimeOwnedPath } from "../runtime-routes.js"
import { createRuntimeRequestListener, type StartRuntimeServerOptions } from "./runtime-server.js"

/** A Node request handler, i.e. what `createServer` takes. */
export type ServeFallback = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>

export interface ServeOptions extends StartRuntimeServerOptions {
  /**
   * Everything the runtime does not own.
   *
   * An app that serves its own HTTP surfaces beside the agent passes its
   * handler here — a framework handler, an Express/Hono adapter, a static file
   * server. Omitted, the runtime answers every path (and 404s what it does not
   * recognise), which is the right shape for an app that serves nothing of its
   * own.
   */
  readonly fallback?: ServeFallback
  /**
   * Handle SIGINT and SIGTERM by running the ordered shutdown. Defaults to
   * `true`: this is an entry point, not a component embedded in a larger host.
   * A host that owns signals passes `false` and calls `close()` itself.
   */
  readonly installSignalHandlers?: boolean
  /** Called once with the listening URL. Defaults to a `console.log` line. */
  readonly onListening?: (url: string) => void
}

export interface ServeHandle {
  readonly url: string
  readonly close: () => Promise<void>
}

/** The three shutdown steps, in the one order that is not subtly wrong. */
export interface ServeShutdownTargets {
  /**
   * Stop accepting new connections. Returns the promise that settles when the
   * server has fully closed — which it does not do until its sockets are gone,
   * so it is awaited LAST rather than here.
   */
  readonly stopAccepting: () => Promise<void>
  /** Abort and drain in-flight runs, then release the runtime's resources. */
  readonly closeRuntime: () => Promise<void>
  /** Drop idle keep-alive sockets, which nothing else will close. */
  readonly dropConnections: () => void
}

/**
 * Shut a composed server down in the order that actually terminates.
 *
 * 1. Stop accepting, so no new request joins the set being drained.
 * 2. Close the runtime, so in-flight runs abort and streams finish.
 * 3. Drop the remaining keep-alive sockets, which are idle and would otherwise
 *    hold the server open until the client wanders off.
 *
 * Awaiting the server's close BEFORE step 3 deadlocks, and dropping
 * connections BEFORE step 2 cuts a streaming response off mid-flight — both
 * are what every hand-written dev entry point has to rediscover.
 */
export async function shutdownServe(targets: ServeShutdownTargets): Promise<void> {
  const serverClosed = targets.stopAccepting()
  await targets.closeRuntime()
  targets.dropConnections()
  await serverClosed
}

/**
 * Serve the B4.run runtime and an application's own routes from one port.
 *
 * The runtime's surfaces are B4's to know, not the app's: `serve` routes them
 * from the single definition in `lib/runtime-routes.ts` — the same one the
 * Vercel target's route table is built from — and hands every other request to
 * `fallback`. A host that hand-writes that split drifts the moment the runtime
 * grows a surface, serving 404s (or, behind a SPA fallback, HTML) for
 * endpoints B4 provides.
 *
 * Every other option is `startRuntimeServer`'s, passed through untouched.
 */
export async function serve(options: ServeOptions): Promise<ServeHandle> {
  const {
    fallback,
    installSignalHandlers = true,
    onListening = defaultOnListening,
    ...runtimeOptions
  } = options

  const runtime = await createRuntimeRequestListener(runtimeOptions)

  const server = createServer((request, response) => {
    if (fallback === undefined || isRuntimeOwnedPath(pathnameOf(request.url))) {
      runtime.listener(request, response)
      return
    }
    void Promise.resolve(fallback(request, response)).catch((error: unknown) => {
      failFallback(response, error)
    })
  })

  try {
    await listen(server, options.host, options.port)
  } catch (error) {
    await runtime.close()
    throw error
  }

  const address = server.address()
  if (!address || typeof address === "string") {
    await runtime.close()
    throw new Error("Runtime server did not bind to a TCP address")
  }

  const url = `http://${toUrlHost(options.host)}:${(address as AddressInfo).port}`
  onListening(url)

  let closing: Promise<void> | undefined

  const close = (): Promise<void> => {
    closing ??= (async () => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      await shutdownServe({
        closeRuntime: runtime.close,
        dropConnections: () => server.closeAllConnections(),
        stopAccepting: () =>
          new Promise<void>((resolve, reject) => {
            // An already-closed server reports ERR_SERVER_NOT_RUNNING; close()
            // is idempotent, so that is a no-op rather than a rejection.
            server.close((error) => (error ? reject(error) : resolve()))
          }).catch(() => undefined),
      })
    })()
    return closing
  }

  const onSignal = (): void => {
    void close()
  }

  if (installSignalHandlers) {
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  }

  return { close, url }
}

function defaultOnListening(url: string): void {
  console.log(`B4.run runtime listening on ${url}`)
}

/** The request's pathname, with the query string and any absolute-form host removed. */
function pathnameOf(requestUrl: string | undefined): string {
  return new URL(requestUrl ?? "/", "http://localhost").pathname
}

function failFallback(response: ServerResponse, error: unknown): void {
  console.error(error instanceof Error ? error.stack : error)
  if (response.headersSent) {
    // The fallback already committed to a status; the only honest signal left
    // is a truncated body.
    response.destroy()
    return
  }
  response.writeHead(500, { "content-type": "application/json" })
  response.end(JSON.stringify({ error: "Request handler failed" }))
}

/**
 * Map a bind host to a dialable URL host — the same mapping
 * `startRuntimeServer` reports, so both entry points name a URL that resolves.
 */
function toUrlHost(host: string | undefined): string {
  const resolved = host ?? "127.0.0.1"
  if (resolved === "0.0.0.0") return "127.0.0.1"
  if (resolved === "::") return "[::1]"
  if (resolved.includes(":") && !resolved.startsWith("[")) return `[${resolved}]`
  return resolved
}

async function listen(
  server: ReturnType<typeof createServer>,
  host?: string,
  port?: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port ?? 0, host ?? "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}
