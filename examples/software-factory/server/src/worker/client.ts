import { parseSse } from "./sse.js"
import {
  CancelResponseSchema,
  ErrorBodySchema,
  type InterruptFrame,
  PendingInterruptsSchema,
  type StreamFrame,
  ThreadSchema,
} from "./wire.js"

export type ResumePayload = "once" | "deny"

export interface Resolution {
  readonly interruptId: string
  readonly payload: ResumePayload
}

export type CancelResult = "interrupted" | "no_run_in_flight" | "thread_not_found"

/** The seven Agent Protocol calls the controller uses. Nothing else is reachable through this type. */
export interface WorkerClient {
  createThread(metadata: Record<string, unknown>): Promise<string>
  startRun(
    threadId: string,
    route: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<StreamFrame>>
  reattach(threadId: string, signal?: AbortSignal): Promise<AsyncIterable<StreamFrame>>
  pendingInterrupts(threadId: string): Promise<InterruptFrame[]>
  resume(
    threadId: string,
    route: string,
    resolutions: readonly Resolution[],
    signal?: AbortSignal,
  ): Promise<AsyncIterable<StreamFrame>>
  cancel(threadId: string): Promise<CancelResult>
  getThread(threadId: string): Promise<{ threadId: string; status: string } | null>
}

/** A non-2xx HTTP response from the worker. Transport failures (fetch rejecting) propagate as the underlying error, not this type. */
export class WorkerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`Worker responded ${status}${code ? ` (${code})` : ""}: ${message}`)
    this.name = "WorkerHttpError"
  }
}

async function toError(response: Response): Promise<WorkerHttpError> {
  const text = await response.text()
  let message = text
  let code: string | undefined
  try {
    const body = ErrorBodySchema.parse(JSON.parse(text))
    message = body.error.message
    const detailCode = body.error.details?.code
    code = typeof detailCode === "string" ? detailCode : undefined
  } catch {
    // Non-JSON error body: keep the raw text.
  }
  return new WorkerHttpError(response.status, code, message)
}

export function createHttpWorkerClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): WorkerClient {
  const base = baseUrl.replace(/\/$/, "")
  const threadPath = (threadId: string, tail = "") =>
    `${base}/threads/${encodeURIComponent(threadId)}${tail}`

  async function jsonRequest(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    if (!headers.has("content-type")) headers.set("content-type", "application/json")
    const response = await fetchImpl(url, { ...init, headers })
    if (!response.ok) throw await toError(response)
    return response
  }

  async function streamRequest(
    url: string,
    init: RequestInit,
  ): Promise<AsyncIterable<StreamFrame>> {
    const response = await jsonRequest(url, init)
    if (!response.body) throw new WorkerHttpError(response.status, undefined, "Stream had no body")
    return parseSse(response.body)
  }

  return {
    async createThread(metadata) {
      const response = await jsonRequest(`${base}/threads`, {
        method: "POST",
        body: JSON.stringify({ metadata }),
      })
      return ThreadSchema.parse(await response.json()).thread_id
    },
    startRun(threadId, route, content, signal) {
      return streamRequest(threadPath(threadId, "/runs/stream"), {
        method: "POST",
        body: JSON.stringify({ route, input: { messages: [{ role: "user", content }] } }),
        ...(signal ? { signal } : {}),
      })
    },
    reattach(threadId, signal) {
      return streamRequest(threadPath(threadId, "/runs/stream"), {
        method: "GET",
        ...(signal ? { signal } : {}),
      })
    },
    async pendingInterrupts(threadId) {
      const response = await jsonRequest(threadPath(threadId, "/pending_interrupts"), {
        method: "GET",
      })
      return PendingInterruptsSchema.parse(await response.json()).interrupts
    },
    resume(threadId, route, resolutions, signal) {
      return streamRequest(threadPath(threadId, "/resume"), {
        method: "POST",
        body: JSON.stringify({
          resume: resolutions.map((r) => ({
            interruptId: r.interruptId,
            status: "resolved",
            payload: r.payload,
          })),
          route,
        }),
        ...(signal ? { signal } : {}),
      })
    },
    async cancel(threadId) {
      const response = await fetchImpl(threadPath(threadId, "/cancel"), { method: "POST" })
      if (response.ok) {
        CancelResponseSchema.parse(await response.json())
        return "interrupted"
      }
      const error = await toError(response)
      if (error.status === 404) return "thread_not_found"
      if (error.status === 409 && error.code === "no_run_in_flight") return "no_run_in_flight"
      throw error
    },
    async getThread(threadId) {
      const response = await fetchImpl(threadPath(threadId), { method: "GET" })
      if (response.status === 404) return null
      if (!response.ok) throw await toError(response)
      const thread = ThreadSchema.parse(await response.json())
      return { threadId: thread.thread_id, status: thread.status }
    },
  }
}
