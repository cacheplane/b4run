import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * The request body as a web stream the adapter owns. Nothing touches the socket
 * until the handler first reads: a body no handler reads is left to Node, which
 * discards it after the response as it always has. Once reading, each chunk is
 * delivered on demand (backpressure pauses the socket). `cancel` (a handler
 * refusing a body, read in part or not at all) DISCARDS the rest of the upload
 * with `req.resume()` instead of destroying the socket, so a response written
 * before the body was read, such as a 413, reaches the client whole.
 */
function drainableBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let attached = false
  let cancelled = false
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (attached) {
          req.resume()
          return
        }
        attached = true
        // The client may have gone before the handler first read (a route that awaits a
        // lookup and a policy first). No `end` or `error` will come again, so answer now.
        if (req.errored || req.readableAborted || (req.destroyed && !req.readableEnded)) {
          controller.error(req.errored ?? new Error("aborted"))
          return
        }
        req.on("data", (chunk: Buffer) => {
          if (cancelled) return
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
          if ((controller.desiredSize ?? 0) <= 0) req.pause()
        })
        req.on("end", () => {
          if (!cancelled) controller.close()
        })
        req.on("error", (error) => {
          if (!cancelled) controller.error(error)
        })
        // A close without an end is a dropped upload, whether or not `error` fired first
        // (erroring an already-errored or closed stream is a no-op).
        req.on("close", () => {
          if (!cancelled && !req.readableEnded) controller.error(new Error("aborted"))
        })
        req.resume()
      },
      cancel() {
        cancelled = true
        req.resume()
      },
    },
    // Zero: `pull` runs only when the handler reads, never eagerly at construction.
    { highWaterMark: 0 },
  )
}

/**
 * Wrap a Node request as a Web `Request`. The socket closing aborts
 * `request.signal`.
 *
 * When the paired `ServerResponse` is available, pass it: on a real server
 * (Node >= 16) the IncomingMessage's own `close` event fires when the request
 * *message* completes — i.e. as soon as the body has been received — not when
 * the client disconnects. A premature client disconnect is instead observable
 * as the response closing before it ended, so with `res` provided the abort
 * signal keys off that. Without `res` (e.g. a bare injected request), the
 * request's `close` event is the only disconnect signal available.
 */
export function toWebRequest(req: IncomingMessage, res?: ServerResponse): Request {
  const controller = new AbortController()
  if (res) {
    res.on("close", () => {
      if (!res.writableEnded) controller.abort()
    })
  } else {
    req.on("close", () => controller.abort())
  }

  // `||` (not `??`): an empty Host header must fall back too, or the URL
  // constructor below throws on `http://`.
  const host = req.headers.host || "localhost"
  let url: URL
  try {
    url = new URL(req.url ?? "/", `http://${host}`)
  } catch {
    // The Host header did not form a valid URL authority (e.g. `Host: not a
    // host`). The pre-refactor server never parsed the Host header, so a
    // malformed one must not turn into a 500 — fall back to localhost.
    try {
      url = new URL(req.url ?? "/", "http://localhost")
    } catch {
      // req.url itself is unparsable — last-resort root URL.
      url = new URL("/", "http://localhost")
    }
  }

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else headers.set(key, value)
  }

  const method = req.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"

  return new Request(url, {
    method,
    headers,
    signal: controller.signal,
    ...(hasBody ? { body: drainableBody(req), duplex: "half" } : {}),
  } as RequestInit & { duplex?: "half" })
}

/**
 * Statuses Node itself refuses to frame a body for. An explicit
 * `content-length` on these would reach the wire, so they are left alone.
 */
const STATUSES_WITHOUT_BODY = new Set([204, 205, 304])

/** Pipe a Web `Response` into a Node response, streaming the body incrementally. */
export async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of response.headers) {
    // `getSetCookie` preserves multiple Set-Cookie headers, which `Headers`
    // iteration would otherwise join into one comma-separated value.
    if (key.toLowerCase() === "set-cookie") continue
    headers[key] = value
  }
  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length > 0) headers["set-cookie"] = setCookie

  if (!response.body) {
    // `writeHead` commits the headers before Node can see that the body is
    // empty, so without this it picks `Transfer-Encoding: chunked` — while the
    // pre-refactor `res.end(payload)` framed an empty payload as
    // `Content-Length: 0`. Set it explicitly to keep the JSON-framing
    // invariant below true for body-less replies too (a middleware
    // `reject(401)` with no body is one).
    //
    // Guarded on the status: Node forwards an explicit `content-length` even
    // on 204/205/304, where the old path never sent one and RFC 7230 3.3.2
    // forbids it. Those statuses keep Node's own suppression.
    if (!STATUSES_WITHOUT_BODY.has(response.status) && response.status >= 200) {
      headers["content-length"] = "0"
    }
    res.writeHead(response.status, headers)
    res.end()
    return
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (/^application\/json\b/i.test(contentType)) {
    // JSON replies were sent by the pre-refactor server as a single
    // `res.end(payload)`, which Node frames with `Content-Length`. Piping the
    // Response's ReadableStream chunk-by-chunk would instead emit
    // `Transfer-Encoding: chunked` — buffer and send in one shot with an
    // explicit Content-Length to stay indistinguishable on the wire.
    const buf = Buffer.from(await response.arrayBuffer())
    headers["content-length"] = String(buf.byteLength)
    res.writeHead(response.status, headers)
    res.write(buf)
    res.end()
    return
  }

  res.writeHead(response.status, headers)
  const reader = response.body.getReader()
  let disconnected = false
  let resume: (() => void) | undefined
  const onDrain = () => resume?.()
  const onDisconnect = () => {
    disconnected = true
    resume?.()
    // Cancelling a pending read also releases an attach subscriber. It must
    // not wait for another producer event or a socket drain that will not come.
    void reader.cancel().catch(() => {})
  }
  res.on("drain", onDrain)
  res.on("close", onDisconnect)
  res.on("error", onDisconnect)
  try {
    if (res.destroyed) onDisconnect()
    while (!disconnected) {
      const next = await reader.read()
      if (disconnected || next.done) break
      if (next.value && !res.write(next.value)) {
        await new Promise<void>((resolve) => {
          resume = resolve
          if (disconnected || res.destroyed) resolve()
        })
        resume = undefined
      }
    }
    if (!disconnected) res.end()
  } catch (error) {
    // A truncated stream is a transport error, never a clean completion.
    res.destroy(error instanceof Error ? error : new Error(String(error)))
    void reader.cancel().catch(() => {})
  } finally {
    res.off("drain", onDrain)
    res.off("close", onDisconnect)
    res.off("error", onDisconnect)
    reader.releaseLock()
  }
}
