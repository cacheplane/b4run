import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

/**
 * happy:                prepareReview result, then the exportForReview gate (parks)
 * gate_before_prepare:  the gate arrives with no prepareReview result (digest unknown)
 * route_error:          done with output.error
 * no_candidate:         done without a candidate or a gate
 * hang:                 one chunk frame, then ping comments until cancelled
 * close_midway:         prepareReview result, then the socket is destroyed; the run parks on the gate 50 ms later
 * unexpected_interrupt: a `command` kind interrupt instead of the gate
 * reattach_ends_busy:   prepareReview result, then the socket is destroyed and the turn never
 *                       ends: the thread keeps reporting `busy`, and a reattached GET stream
 *                       ends without a terminal frame instead of waiting for one. The only
 *                       shape in which a reattachment can end while the run is still live,
 *                       which is what the controller's reattach bound is for.
 */
export type RunBehaviour =
  | "happy"
  | "gate_before_prepare"
  | "route_error"
  | "no_candidate"
  | "hang"
  | "close_midway"
  | "reattach_ends_busy"
  | "unexpected_interrupt"
/** What a resume with payload `once` does. `deny` always ends the turn without a receipt. */
export type ResumeBehaviour = "receipt" | "no_receipt" | "route_error"

export interface FakeWorkerOptions {
  readonly outboxDir: string
  readonly run?: RunBehaviour
  readonly resume?: ResumeBehaviour
  /** Milliseconds between frames; keep small in tests. */
  readonly frameDelayMs?: number
}

export interface LoggedRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

interface Thread {
  readonly id: string
  status: "idle" | "busy" | "interrupted"
  runActive: boolean
  resumeActive: boolean
  pending: Record<string, unknown> | null
  /** Ends the live POST stream (hang) with the given terminal frame. */
  endLive: ((done: unknown) => void) | null
  /** Reattached GET streams waiting for this run's terminal frame. */
  waiters: Set<(done: unknown) => void>
}

export interface FakeWorker {
  readonly baseUrl: string
  readonly digest: string
  readonly candidate: Record<string, unknown>
  readonly requests: LoggedRequest[]
  behaviour: { run: RunBehaviour; resume: ResumeBehaviour }
  thread(id: string): Readonly<Thread> | undefined
  waitForRunStart(threadId: string): Promise<void>
  close(): Promise<void>
}

const DIGEST = createHash("sha256").update("fake-candidate").digest("hex")
const CANDIDATE = {
  version: 1,
  workspaceId: "fake-workspace",
  sourceDigest: "a".repeat(64),
  changes: { "src/cli.ts": "export const fixed = true\n" },
  receiptDigest: DIGEST,
}

function errorBody(message: string, code?: string) {
  return JSON.stringify({ error: { message, ...(code ? { details: { code } } : {}) } })
}

function json(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of req) chunks.push(chunk as Buffer)
  } catch {
    return null
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (text === "") return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

class Sse {
  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.on("error", () => {})
  }
  frame(event: string, data: unknown) {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  comment(text: string) {
    this.res.write(`: ${text}\n\n`)
  }
  end() {
    this.res.end()
  }
  /** Cut the socket, but only once the frames already written have reached it. */
  async destroy() {
    await new Promise<void>((resolve) => {
      this.res.write(": flush\n\n", () => resolve())
    })
    // The write callback means "handed to the socket", not "read by the client": yield once
    // more so the frames already written are not lost with the connection.
    await new Promise<void>((resolve) => setImmediate(resolve))
    this.res.destroy()
  }
}

export async function createFakeWorker(options: FakeWorkerOptions): Promise<FakeWorker> {
  const threads = new Map<string, Thread>()
  const requests: LoggedRequest[] = []
  const behaviour = { run: options.run ?? "happy", resume: options.resume ?? "receipt" }
  const delay = options.frameDelayMs ?? 5
  let counter = 0
  const runStarted = new Map<string, () => void>()
  const closing = new AbortController()

  /** Sleeps for `ms`, or resolves `true` early if `close()` has fired — the caller must stop writing. */
  async function sleepOrAbort(ms: number): Promise<boolean> {
    try {
      await sleep(ms, undefined, { signal: closing.signal })
      return false
    } catch (err) {
      if (closing.signal.aborted) return true
      throw err
    }
  }

  const gateInterrupt = () => ({
    interruptId: `perm-export-${++counter}`,
    type: "permission-request",
    kind: "tool",
    detail: {
      toolName: "exportForReview",
      argsPreview: JSON.stringify({ candidate: CANDIDATE }).slice(0, 500),
      suggestedPattern: "exportForReview",
    },
  })
  const prepareResult = () => ({
    id: "call-2",
    name: "prepareReview",
    output: JSON.stringify({
      task: "cli-flags",
      candidate: CANDIDATE,
      diff: "--- a/src/cli.ts\n+++ b/src/cli.ts\n",
      verification: { passed: true },
    }),
  })

  function notify(thread: Thread, done: unknown) {
    for (const waiter of thread.waiters) waiter(done)
    thread.waiters.clear()
  }
  /** The turn finished with no pending prompt. */
  function finishRun(thread: Thread, sse: Sse | null) {
    thread.runActive = false
    thread.endLive = null
    thread.status = "idle"
    notify(thread, { output: {} })
    sse?.end()
  }
  /** The turn parked on `thread.pending`. */
  function parkRun(thread: Thread, sse: Sse | null) {
    thread.runActive = false
    thread.endLive = null
    thread.status = "interrupted"
    notify(thread, { output: {} })
    sse?.end()
  }

  async function streamRun(thread: Thread, sse: Sse) {
    const kind = behaviour.run
    if (kind === "route_error") {
      sse.frame("done", { output: { error: "route exploded" } })
      return finishRun(thread, sse)
    }
    if (kind === "no_candidate") {
      sse.frame("chunk", "I could not repair it.")
      sse.frame("done", { output: {} })
      return finishRun(thread, sse)
    }
    if (kind === "hang") {
      // A real frame, not just a comment: the SSE parser drops comments, so a comment-only
      // hang would never let the controller observe the run as started.
      sse.frame("chunk", "working")
      sse.comment("ping")
      await new Promise<void>((resolve) => {
        thread.endLive = (done) => {
          sse.frame("done", done)
          sse.end()
          resolve()
        }
      })
      return
    }
    if (kind === "unexpected_interrupt") {
      thread.pending = {
        interruptId: `perm-cmd-${++counter}`,
        type: "permission-request",
        kind: "command",
        detail: { command: "rm -rf /", suggestedPattern: "rm" },
      }
      sse.frame("interrupt", thread.pending)
      sse.frame("done", { output: {} })
      return parkRun(thread, sse)
    }
    if (kind === "gate_before_prepare") {
      thread.pending = gateInterrupt()
      sse.frame("interrupt", thread.pending)
      sse.frame("done", { output: {} })
      return parkRun(thread, sse)
    }
    sse.frame("tool_result", { id: "call-1", name: "readFile", output: "TASK.md contents" })
    if (await sleepOrAbort(delay)) return
    sse.frame("tool_result", prepareResult())
    if (kind === "close_midway") {
      await sse.destroy()
      if (await sleepOrAbort(50)) return
      thread.pending = gateInterrupt()
      return parkRun(thread, null)
    }
    if (kind === "reattach_ends_busy") {
      // Nothing clears runActive or status: the turn stays live for as long as the worker does.
      await sse.destroy()
      return
    }
    if (await sleepOrAbort(delay)) return
    thread.pending = gateInterrupt()
    sse.frame("interrupt", thread.pending)
    sse.frame("done", { output: {} })
    return parkRun(thread, sse)
  }

  async function streamResume(thread: Thread, sse: Sse, payload: string) {
    thread.resumeActive = true
    thread.pending = null
    thread.status = "busy"
    if (payload === "deny") {
      sse.frame("chunk", "Export was denied; stopping.")
      sse.frame("done", { output: {} })
    } else if (behaviour.resume === "route_error") {
      sse.frame("done", { output: { error: "export failed" } })
    } else {
      if (behaviour.resume === "receipt")
        writeFileSync(
          join(options.outboxDir, `${DIGEST}.json`),
          JSON.stringify({ task: "cli-flags", candidate: CANDIDATE, diff: "" }),
        )
      sse.frame("tool_result", { id: "call-3", name: "exportForReview", output: "exported" })
      sse.frame("done", { output: {} })
    }
    thread.resumeActive = false
    thread.status = "idle"
    sse.end()
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const body = await readBody(req)
    requests.push({ method: req.method ?? "", path: url.pathname, body })
    const parts = url.pathname.split("/").filter(Boolean)

    if (req.method === "POST" && url.pathname === "/threads") {
      const id = `fake-thread-${++counter}`
      threads.set(id, {
        id,
        status: "idle",
        runActive: false,
        resumeActive: false,
        pending: null,
        endLive: null,
        waiters: new Set(),
      })
      return json(
        res,
        200,
        JSON.stringify({
          thread_id: id,
          status: "idle",
          metadata: (body as { metadata?: unknown })?.metadata ?? {},
        }),
      )
    }

    const thread = parts[0] === "threads" && parts[1] ? threads.get(parts[1]) : undefined
    if (!thread) return json(res, 404, errorBody("Thread not found", "thread_not_found"))
    const tail = parts.slice(2).join("/")

    if (req.method === "GET" && tail === "")
      return json(res, 200, JSON.stringify({ thread_id: thread.id, status: thread.status }))

    if (req.method === "GET" && tail === "pending_interrupts")
      return json(res, 200, JSON.stringify({ interrupts: thread.pending ? [thread.pending] : [] }))

    if (req.method === "POST" && tail === "runs/stream") {
      if (thread.runActive || thread.resumeActive || thread.pending)
        return json(res, 409, errorBody("Run in flight", "run_in_flight"))
      thread.runActive = true
      thread.status = "busy"
      runStarted.get(thread.id)?.()
      await streamRun(thread, new Sse(res))
      return
    }

    if (req.method === "GET" && tail === "runs/stream") {
      const sse = new Sse(res)
      sse.frame("state", {
        status: thread.status,
        live: thread.runActive,
        interrupts: thread.pending ? [thread.pending] : [],
      })
      // `reattach_ends_busy` ends the reattached stream although the run is still live.
      if (!thread.runActive || behaviour.run === "reattach_ends_busy") return sse.end()
      await new Promise<void>((resolve) => {
        thread.waiters.add((done) => {
          sse.frame("done", done)
          resolve()
        })
      })
      return sse.end()
    }

    if (req.method === "POST" && tail === "resume") {
      const request = body as {
        resume?: { interruptId: string; status: string; payload?: string }[]
        route?: string
      }
      if (!Array.isArray(request?.resume) || typeof request.route !== "string")
        return json(res, 400, errorBody("Malformed resume body"))
      if (thread.resumeActive)
        return json(res, 409, errorBody("Resume in progress", "resume_in_progress"))
      if (thread.runActive) return json(res, 409, errorBody("Run in flight", "run_in_flight"))
      const pendingIds = thread.pending ? [thread.pending.interruptId as string] : []
      const givenIds = request.resume.map((r) => r.interruptId)
      if (
        !thread.pending ||
        pendingIds.length !== givenIds.length ||
        pendingIds.some((id) => !givenIds.includes(id))
      )
        return json(
          res,
          409,
          errorBody("Resume set does not match pending interrupts", "interrupt_mismatch"),
        )
      const entry = request.resume[0]
      const payload = entry?.status === "cancelled" ? "deny" : (entry?.payload ?? "deny")
      await streamResume(thread, new Sse(res), payload)
      return
    }

    if (req.method === "POST" && tail === "cancel") {
      if (!thread.runActive)
        return json(res, 409, errorBody("No run in flight", "no_run_in_flight"))
      const done = { output: { cancelled: true } }
      thread.endLive?.(done)
      thread.runActive = false
      thread.endLive = null
      thread.status = "interrupted"
      notify(thread, done)
      return json(res, 200, JSON.stringify({ thread_id: thread.id, status: "interrupted" }))
    }

    return json(res, 404, errorBody("Not found"))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("fake worker did not bind")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    digest: DIGEST,
    candidate: CANDIDATE,
    requests,
    behaviour,
    thread: (id) => threads.get(id),
    waitForRunStart(threadId) {
      const thread = threads.get(threadId)
      if (thread?.runActive) return Promise.resolve()
      return new Promise((resolve) => runStarted.set(threadId, resolve))
    },
    async close() {
      closing.abort()
      for (const thread of threads.values()) {
        thread.endLive?.({ output: { cancelled: true } })
        notify(thread, { output: { cancelled: true } })
      }
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
