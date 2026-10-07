import { type BaseEvent, EventType } from "@ag-ui/core"
import { type AgentRunnerConnectRequest, InMemoryAgentRunner } from "@copilotkit/runtime/v2"
import { Observable, type Subscription } from "rxjs"

export interface B4AgentRunnerOptions {
  /** The B4 server's base URL: the origin `B4HttpAgent` posts `/agui/...` to. */
  readonly url: string
  /**
   * Fetch for the replay read, and the only way to authenticate it: the runner
   * never forwards the connect request's headers (CopilotKit copies the
   * browser's `authorization` and `x-*` headers there, and forwarding them would
   * let a browser name another caller). It must carry the CURRENT caller's
   * identity, derived per request (for example from an `AsyncLocalStorage` the
   * route handler fills), never a fixed service credential: a fixed credential
   * lets any browser restore any thread whose id it knows. A read the thread
   * gate refuses (404) restores as an empty chat, with no error.
   */
  readonly fetch?: typeof fetch
  /**
   * Called once per replay that carried warnings (stamps the server could not
   * read). Defaults to `console.warn`.
   */
  readonly onWarnings?: (threadId: string, warnings: readonly string[]) => void
}

interface EventsBody {
  readonly events?: readonly BaseEvent[]
  readonly warnings?: readonly string[]
}

/** `Array.prototype.findLastIndex` (ES2023; this package compiles against ES2022). */
function lastIndexOf<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (match(items[index] as T)) return index
  return -1
}

function isRunStart(event: BaseEvent): boolean {
  return event.type === EventType.RUN_STARTED
}

function isRunEnd(event: BaseEvent): boolean {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR
}

/**
 * The replay without its trailing open turn: when the last `RUN_STARTED` has
 * no `RUN_FINISHED`/`RUN_ERROR` after it, that turn is the checkpoint's view
 * of a run still in flight, which the live tail carries in full.
 */
function withoutOpenTurn(events: readonly BaseEvent[]): readonly BaseEvent[] {
  const lastStart = lastIndexOf(events, isRunStart)
  if (lastStart === -1 || events.slice(lastStart + 1).some(isRunEnd)) return events
  return events.slice(0, lastStart)
}

/**
 * The live run's `RUN_STARTED` with `input.messages` cut to the final user
 * message. The in-memory runner records the client's whole message list there;
 * the earlier ones are already in the B4 history (under checkpoint ids) and
 * would render twice.
 */
function withLastUserMessageOnly(event: BaseEvent): BaseEvent {
  const input = (event as { input?: unknown }).input
  if (typeof input !== "object" || input === null) return event
  const messages = (input as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return event
  const lastUserIndex = lastIndexOf(
    messages as readonly unknown[],
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "user",
  )
  const lastUser = lastUserIndex === -1 ? undefined : messages[lastUserIndex]
  return {
    ...event,
    input: { ...input, messages: lastUser === undefined ? [] : [lastUser] },
  } as BaseEvent
}

/** True when the `RUN_STARTED` opens a run that answers interrupts (`input.resume`). */
function isResumeStart(event: BaseEvent): boolean {
  const input = (event as { input?: { resume?: unknown } }).input
  return Array.isArray(input?.resume) && input.resume.length > 0
}

/**
 * Where the live turn starts in the in-memory batch. A resumed run continues
 * the turn its parked run opened (B4 replays both as one turn), so when the
 * run right before it in the batch ended on an interrupt, the turn starts at
 * that parked run's `RUN_STARTED`.
 */
function liveTurnStart(replayed: readonly BaseEvent[], currentStart: number): number {
  if (!isResumeStart(replayed[currentStart] as BaseEvent)) return currentStart
  const parkedStart = lastIndexOf(replayed.slice(0, currentStart), isRunStart)
  if (parkedStart === -1) return currentStart
  const parkedEnd = replayed[currentStart - 1] as { type: string; outcome?: { type?: unknown } }
  const parked =
    parkedEnd.type === EventType.RUN_FINISHED && parkedEnd.outcome?.type === "interrupt"
  return parked ? parkedStart : currentStart
}

/** `url` without trailing slashes; a loop, not a regex, so a long run of slashes stays linear. */
function withoutTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--
  return url.slice(0, end)
}

/**
 * CopilotKit's in-memory runner with `connect` served from B4's storage. Runs
 * are the in-memory runner's (a run forwards to the route's agent and keeps
 * the live tail in this process). `connect` always reads the thread's history
 * from `GET /threads/:id/events`, so a reload, a restart or another instance
 * restores the chat, its activity and any parked approval from the checkpoint.
 * The read carries only what the configured `fetch` adds, so that fetch must
 * carry the current caller's identity; the browser's headers on the connect
 * request are never forwarded.
 *
 * While a run is live here, the history drops its open head and the runner
 * appends this process's current run, from its `RUN_STARTED`, then passes the
 * live events through as they arrive. A resumed run is appended from the
 * parked run it answers, so the turn keeps its start. Limitation: when the
 * parked run ran on another instance (it is not in this process's memory),
 * the turn restores from the resume's `RUN_STARTED` only, until the next
 * reload after the run ends.
 */
export class B4AgentRunner extends InMemoryAgentRunner {
  readonly #url: string
  readonly #fetch: typeof fetch
  readonly #onWarnings: (threadId: string, warnings: readonly string[]) => void

  constructor(options: B4AgentRunnerOptions) {
    super()
    this.#url = withoutTrailingSlashes(options.url)
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#onWarnings =
      options.onWarnings ??
      ((threadId, warnings) =>
        console.warn(`B4 replay of thread ${threadId}: ${warnings.join("; ")}`))
  }

  /** The thread's replayed events; empty when there is nothing to restore. */
  async #history(
    request: AgentRunnerConnectRequest,
    signal: AbortSignal,
  ): Promise<readonly BaseEvent[]> {
    const response = await this.#fetch(
      `${this.#url}/threads/${encodeURIComponent(request.threadId)}/events`,
      {
        // Deliberately not `request.headers`: those come from the browser.
        headers: { accept: "application/json" },
        signal,
      },
    )
    // 404: no such thread (or not this caller's). 409: created but never ran. Nothing to restore.
    if (response.status === 404 || response.status === 409) {
      await response.body?.cancel()
      return []
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`B4 replay of thread ${request.threadId} failed with ${response.status}`)
    }
    const body = (await response.json()) as EventsBody
    if (body.warnings !== undefined && body.warnings.length > 0) {
      this.#onWarnings(request.threadId, body.warnings)
    }
    return body.events ?? []
  }

  override connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const connectLive = (live: AgentRunnerConnectRequest) => super.connect(live)
    return new Observable<BaseEvent>((subscriber) => {
      const controller = new AbortController()
      let live: Subscription | undefined
      const restore = async (): Promise<void> => {
        // Narrow race: a run that starts in this process during the history read
        // is replayed as an open head with no live tail until the next reload.
        const wasRunning = await this.isRunning({ threadId: request.threadId })
        const history = await this.#history(request, controller.signal)
        if (controller.signal.aborted) return
        if (!wasRunning) {
          for (const event of history) subscriber.next(event)
          subscriber.complete()
          return
        }
        if (!(await this.isRunning({ threadId: request.threadId }))) {
          // The run ended while the history was read busy; its open head is stale.
          const settled = await this.#history(request, controller.signal)
          if (controller.signal.aborted) return
          for (const event of settled) subscriber.next(event)
          subscriber.complete()
          return
        }
        if (controller.signal.aborted) return
        for (const event of withoutOpenTurn(history)) subscriber.next(event)
        // The in-memory runner replays its retained runs and the current run's
        // buffer synchronously during subscribe; only the current run (from its
        // RUN_STARTED) is new to the B4 history. Later events pass straight through.
        let buffer: BaseEvent[] | undefined = []
        let ended: { error: unknown } | "complete" | undefined
        // Set when the current run has not emitted yet: its RUN_STARTED arrives live.
        let cutNextRunStart = false
        live = connectLive(request).subscribe({
          next: (event) => {
            if (buffer !== undefined) {
              buffer.push(event)
            } else if (cutNextRunStart && isRunStart(event)) {
              cutNextRunStart = false
              subscriber.next(withLastUserMessageOnly(event))
            } else {
              subscriber.next(event)
            }
          },
          error: (error: unknown) => {
            if (buffer !== undefined) ended = { error }
            else subscriber.error(error)
          },
          complete: () => {
            if (buffer !== undefined) ended = "complete"
            else subscriber.complete()
          },
        })
        const replayed = buffer
        buffer = undefined
        const currentStart = lastIndexOf(replayed, isRunStart)
        const lastRunClosed = currentStart !== -1 && replayed.slice(currentStart + 1).some(isRunEnd)
        if (currentStart === -1 || (lastRunClosed && ended === undefined)) {
          // Connected between run() and the run's first event: the batch holds
          // only finished runs the B4 history already has.
          cutNextRunStart = true
        } else {
          for (const event of replayed.slice(liveTurnStart(replayed, currentStart))) {
            subscriber.next(isRunStart(event) ? withLastUserMessageOnly(event) : event)
          }
        }
        if (ended === "complete") subscriber.complete()
        else if (ended !== undefined) subscriber.error(ended.error)
      }
      restore().catch((error: unknown) => {
        if (!controller.signal.aborted) subscriber.error(error)
      })
      return () => {
        controller.abort()
        live?.unsubscribe()
      }
    })
  }
}
