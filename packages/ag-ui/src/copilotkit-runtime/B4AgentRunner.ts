import type { BaseEvent } from "@ag-ui/core"
import { type AgentRunnerConnectRequest, InMemoryAgentRunner } from "@copilotkit/runtime/v2"
import { Observable } from "rxjs"

export interface B4AgentRunnerOptions {
  /** The B4 server's base URL: the origin `B4HttpAgent` posts `/agui/...` to. */
  readonly url: string
  /** Fetch for the replay read; pass the same one your `B4HttpAgent` uses to add auth headers. */
  readonly fetch?: typeof fetch
  /** Called once per replay that carried warnings (stamps the server could not read). Defaults to `console.warn`. */
  readonly onWarnings?: (threadId: string, warnings: readonly string[]) => void
}

interface EventsBody {
  readonly events?: readonly BaseEvent[]
  readonly warnings?: readonly string[]
}

/**
 * CopilotKit's in-memory runner with `connect` served from B4's storage. Runs
 * are the in-memory runner's (a run forwards to the route's agent and keeps
 * the live tail in this process); `connect` rejoins that tail while the run is
 * live here, and otherwise replays `GET /threads/:id/events`, so a reload, a
 * restart or another instance restores the chat, its activity and any parked
 * approval from the checkpoint.
 */
export class B4AgentRunner extends InMemoryAgentRunner {
  readonly #url: string
  readonly #fetch: typeof fetch
  readonly #onWarnings: (threadId: string, warnings: readonly string[]) => void

  constructor(options: B4AgentRunnerOptions) {
    super()
    this.#url = options.url.replace(/\/+$/, "")
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#onWarnings =
      options.onWarnings ??
      ((threadId, warnings) =>
        console.warn(`B4 replay of thread ${threadId}: ${warnings.join("; ")}`))
  }

  override connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const connectLive = (live: AgentRunnerConnectRequest) => super.connect(live)
    return new Observable<BaseEvent>((subscriber) => {
      const controller = new AbortController()
      let live: { unsubscribe(): void } | undefined
      const replay = async (): Promise<void> => {
        if (await this.isRunning({ threadId: request.threadId })) {
          if (controller.signal.aborted) return
          live = connectLive(request).subscribe(subscriber)
          return
        }
        const response = await this.#fetch(
          `${this.#url}/threads/${encodeURIComponent(request.threadId)}/events`,
          {
            headers: { ...request.headers, accept: "application/json" },
            signal: controller.signal,
          },
        )
        // 404: no such thread (or not this caller's). 409: created but never ran. Nothing to restore.
        if (response.status === 404 || response.status === 409) {
          subscriber.complete()
          return
        }
        if (!response.ok) {
          throw new Error(`B4 replay of thread ${request.threadId} failed with ${response.status}`)
        }
        const body = (await response.json()) as EventsBody
        if (body.warnings !== undefined && body.warnings.length > 0) {
          this.#onWarnings(request.threadId, body.warnings)
        }
        for (const event of body.events ?? []) subscriber.next(event)
        subscriber.complete()
      }
      replay().catch((error: unknown) => {
        if (!controller.signal.aborted) subscriber.error(error)
      })
      return () => {
        controller.abort()
        live?.unsubscribe()
      }
    })
  }
}
