import { setTimeout as sleep } from "node:timers/promises"
import type { SourceBundle, StagedWorkspaceReference } from "@b4run/workspace"
import { parseSse } from "./sse.js"
import {
  CancelResponseSchema,
  ErrorBodySchema,
  type InterruptFrame,
  PendingInterruptsSchema,
  StagedSourceResponseSchema,
  type StreamFrame,
  ThreadSchema,
} from "./wire.js"

export type ResumePayload = "once" | "deny"

export interface Resolution {
  readonly interruptId: string
  readonly payload: ResumePayload
}

export type CancelResult = "interrupted" | "no_run_in_flight" | "thread_not_found"

/** The eight Agent Protocol calls the controller uses. Nothing else is reachable through this type. */
export interface WorkerClient {
  /**
   * Stage a workspace's files on the worker (`PUT /workspace/sources/:digest`),
   * content-addressed: `created` for new bytes, `held` when the worker had them.
   */
  uploadSource(bundle: SourceBundle): Promise<"created" | "held">
  /**
   * `POST /threads`. With `workspace`, the thread is created with the staged source it
   * names (uploaded first), and the worker refuses a digest it does not hold.
   */
  createThread(
    metadata: Record<string, unknown>,
    workspace?: StagedWorkspaceReference,
  ): Promise<string>
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
    /** The response's `retry-after`, in milliseconds, when it gave one in seconds. */
    readonly retryAfterMs?: number,
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
  const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN)
  return new WorkerHttpError(
    response.status,
    code,
    message,
    Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : undefined,
  )
}

/**
 * How often, and how patiently, a busy worker's `429` is retried. A worker takes one upload
 * at a time (`upload_in_flight`) and a few creates naming a workspace at a time
 * (`workspace_create_in_flight`); both refuse before anything is kept, so sending the same
 * request again is safe. Any other refusal, a `429` with another code included, is final.
 */
export interface BusyRetryOptions {
  /** Retries after the first attempt. Default 5. */
  readonly attempts?: number
  /** The first wait; doubled per retry, and never shorter than the worker's `retry-after`. Default 250. */
  readonly baseDelayMs?: number
  /** The longest single wait, whatever `retry-after` asks for. Default 5,000. */
  readonly maxDelayMs?: number
}

export interface HttpWorkerClientOptions {
  /** `FACTORY_WORKER_TOKEN`: sent as `authorization: Bearer <token>` on every request. */
  readonly token: string
  readonly fetch?: typeof fetch
  readonly busyRetry?: BusyRetryOptions
}

/** The `429` codes that mean "this worker is busy with another upload or create; send it again". */
const BUSY_CODES: ReadonlySet<string> = new Set(["upload_in_flight", "workspace_create_in_flight"])

export function createHttpWorkerClient(
  baseUrl: string,
  options: HttpWorkerClientOptions,
): WorkerClient {
  const base = baseUrl.replace(/\/$/, "")
  const fetchImpl = options.fetch ?? fetch
  const authorization = `Bearer ${options.token}`
  /** Every request, with no exception: the worker's policy denies anything without it. */
  const send = (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set("authorization", authorization)
    // A redirect would carry the token to wherever it points: refuse it.
    return fetchImpl(url, { ...init, headers, redirect: "error" })
  }
  const retry = {
    attempts: options.busyRetry?.attempts ?? 5,
    baseDelayMs: options.busyRetry?.baseDelayMs ?? 250,
    maxDelayMs: options.busyRetry?.maxDelayMs ?? 5_000,
  }
  const threadPath = (threadId: string, tail = "") =>
    `${base}/threads/${encodeURIComponent(threadId)}${tail}`

  async function jsonRequest(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    if (!headers.has("content-type")) headers.set("content-type", "application/json")
    const response = await send(url, { ...init, headers })
    if (!response.ok) throw await toError(response)
    return response
  }

  /**
   * `jsonRequest`, sending the same request again while the worker answers that it is busy
   * (`BUSY_CODES`), at most `retry.attempts` more times. Only for the upload and the create,
   * whose busy refusals keep nothing; the body must be a string so it can be sent again.
   */
  async function busyRetried(url: string, init: RequestInit & { body: string }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await jsonRequest(url, init)
      } catch (error) {
        if (
          !(error instanceof WorkerHttpError) ||
          error.status !== 429 ||
          error.code === undefined ||
          !BUSY_CODES.has(error.code) ||
          attempt >= retry.attempts
        )
          throw error
        const asked = error.retryAfterMs ?? 0
        await sleep(Math.min(retry.maxDelayMs, Math.max(asked, retry.baseDelayMs * 2 ** attempt)))
      }
    }
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
    async uploadSource(bundle) {
      const response = await busyRetried(
        `${base}/workspace/sources/${encodeURIComponent(bundle.digest)}`,
        { method: "PUT", body: JSON.stringify(bundle) },
      )
      const staged = StagedSourceResponseSchema.parse(await response.json())
      if (staged.digest !== bundle.digest)
        throw new WorkerHttpError(
          response.status,
          "digest_mismatch",
          `The worker staged ${staged.digest}, not ${bundle.digest}`,
        )
      return staged.status
    },
    async createThread(metadata, workspace) {
      const response = await busyRetried(`${base}/threads`, {
        method: "POST",
        body: JSON.stringify({ metadata, ...(workspace !== undefined ? { workspace } : {}) }),
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
      const response = await send(threadPath(threadId, "/cancel"), { method: "POST" })
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
      const response = await send(threadPath(threadId), { method: "GET" })
      if (response.status === 404) return null
      if (!response.ok) throw await toError(response)
      const thread = ThreadSchema.parse(await response.json())
      return { threadId: thread.thread_id, status: thread.status }
    },
  }
}
