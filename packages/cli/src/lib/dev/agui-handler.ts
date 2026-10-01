import type { IncomingMessage, ServerResponse } from "node:http"
import type { RunAgentInput } from "@ag-ui/core"
import { RunAgentInputSchema } from "@ag-ui/core/schemas"
import { type B4AgentStreamChunk, fromRunAgentInput, toAguiEvents } from "@b4run/ag-ui"
import { encodeAgUiSse } from "@b4run/ag-ui/sse"
import type { B4Config, ClientToolDefinition, MemoryStoreLike } from "@b4run/core"
import { CLIENT_TOOL_PREFIX, isClientToolCallEnvelope } from "@b4run/core"
import type { PermissionsStore } from "@b4run/permissions"
import type {
  ClientToolRecorder,
  MiddlewareAfterHook,
  MiddlewareAfterMessage,
  MiddlewareHandler,
  MiddlewareRequest,
  ThreadAccessPolicy,
} from "@b4run/sdk"
import type { ThreadsStore } from "@b4run/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { checkpointRoutes } from "../runtime/checkpoint-route-provenance.js"
import {
  type BootResolvedInstances,
  checkRouteClientToolsSupport,
  checkRouteResponseFormatSupport,
  materializeResolvedRouteGraph,
  nonAgentClientToolsMessage,
  nonAgentResponseFormatMessage,
  type RouteResumePayload,
  streamResolvedRoute,
} from "../runtime/execute-route-core.js"
import type { SandboxManager } from "../runtime/sandbox-manager.js"
import type { B4StaticModules } from "../runtime/static-modules-core.js"
import type { StreamChunk } from "../runtime/stream-types.js"
import { abortableAsyncIterable } from "./abortable-iterable.js"
import {
  type ApprovalGrantRuntime,
  gateResumeWithGrants,
  minterFor,
  voidSupersededGrants,
} from "./approval-grants.js"
import { payloadTooLarge, RequestBodyTooLargeError, readBoundedText } from "./bounded-body.js"
import {
  ClientToolAbandonError,
  type ClosableAgentGraph,
  CONTINUE_AFTER_CLOSE,
  closeAbandonedClientToolCalls,
} from "./client-tool-abandon.js"
import { readClientToolDefinitions } from "./client-tool-definitions.js"
import {
  AGUI_BODY_MAX_BYTES,
  type ClientToolRuntime,
  DEFAULT_CLIENT_TOOL_TTL_MS,
  MAX_CLIENT_TOOL_RESULT,
} from "./client-tool-runtime.js"
import {
  type ClientToolTurn,
  isClientToolCallExpired,
  resolveClientToolTurn,
} from "./client-tool-turn.js"
import type { LiveTurnHub, LiveTurnProducer } from "./live-turn-hub.js"
import { headersToRecord, runMiddleware } from "./middleware.js"
import { applyMiddlewareAfter } from "./middleware-after.js"
import { toWebRequest, writeNodeResponse } from "./node-web-adapter.js"
import { readParkedRoute, settleParkedRoute } from "./parked-route.js"
import {
  isClientToolPark,
  type PendingInterrupt,
  type PendingInterruptSnapshot,
  type PendingResumeClaims,
  readPendingInterrupts,
  resolvePendingResume,
  withoutClientToolParks,
} from "./pending-interrupts.js"
import { extractRouteParams } from "./request-context.js"
import { readResponseFormat, rejectResponseSchema } from "./response-schema.js"
import { resolveRunEnvelopePolicy, validateRunEnvelope } from "./run-envelope.js"
import type { RunRegistry } from "./run-registry.js"
import type { RuntimeRegistry } from "./runtime-registry-core.js"
import { createRequestErrorBody } from "./server-errors.js"
import { statusResponse } from "./status-response.js"
import { terminalStatus } from "./terminal-status.js"
import type { Gate, GateSpec } from "./thread-gate.js"
import { createGatedThreadForRun, isThenable, makeThreadGate } from "./thread-gate.js"
import { assertNoReservedKey } from "./thread-metadata.js"

export interface AgUiFetchRequestOptions {
  readonly appRoot: string
  /**
   * Boot-resolved approval-grant mode, store and TTL.
   *
   * Optional so direct callers (tests, embedders) keep their existing
   * behavior — and that optionality is safe HERE, unlike at the park site,
   * because absence resolves to `{ mode: "off" }`, which is exactly the
   * pre-grant path. The fail-closed decision lives at the park, not at the
   * handler.
   */
  readonly approvalGrants?: ApprovalGrantRuntime
  /** Boot state (supplied config + node fallbacks) forwarded to route execution. */
  readonly boot?: Pick<BootResolvedInstances, "bootFallbacks" | "config">
  readonly checkpointer: BaseCheckpointSaver
  /**
   * Boot-resolved client tool store and TTL (cacheplane/b4run#743). Optional
   * so direct callers keep their existing behavior; absent means no store,
   * which fails closed: a run that sends client tools, or answers a parked
   * one, is refused with `503 client_tool_store_unavailable`.
   */
  readonly clientTools?: ClientToolRuntime
  /**
   * The boot-resolved `b4.config.ts`, read here only for `server.agui` — which
   * routes opted in to client-supplied `tools` / `forwardedProps`. Optional so
   * direct callers (tests) keep their existing behavior; absent means the
   * closed default, which is the safe one.
   */
  readonly config?: B4Config
  /**
   * Lazy, memoized, boot-built thunk for the shared memory store, forwarded
   * into route execution so the memory capability reuses the same store the
   * `/memory/candidates*` HTTP routes use, instead of opening its own.
   * Optional so direct callers (tests) keep their existing behavior.
   */
  readonly getMemoryStore?: () => Promise<MemoryStoreLike>
  readonly liveTurnHub: LiveTurnHub
  readonly middleware: MiddlewareHandler | undefined
  /**
   * The middleware's final-message hook, when its definition has one. Wraps
   * the route stream so the final assistant message reaches the client only
   * once the hook has answered; absent, the stream is not wrapped at all.
   */
  readonly middlewareAfter?: MiddlewareAfterHook
  /**
   * Boot-resolved permissions store (or a per-request factory in dev),
   * forwarded into route execution so no per-request store construction is
   * needed. Optional so direct callers (tests) keep their existing behavior.
   */
  readonly permissionsStore?: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly resumeClaims: PendingResumeClaims
  readonly runRegistry: RunRegistry
  /**
   * The boot-resolved policy. `undefined` means the app has no policy — the
   * gate below is then a no-op, exactly like every other gated endpoint.
   */
  readonly threadAccess: ThreadAccessPolicy | undefined
  readonly threadsStore: ThreadsStore
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  /**
   * Boot-time static module manifest, when the server booted from one,
   * forwarded into route execution so subagents descriptor maps are derived
   * without entry-file imports. Optional so direct callers (tests) keep
   * their existing behavior.
   */
  readonly staticModules?: B4StaticModules
  readonly request: Request
  readonly routeKey: string
  readonly streamRoute?: typeof streamResolvedRoute
}

interface AgUiRequestOptions extends Omit<AgUiFetchRequestOptions, "request"> {
  readonly request: IncomingMessage
  readonly response: ServerResponse
}

/**
 * Pass-through tap that records whether the turn parked.
 *
 * Separate from `normalizeB4Stream`, and upstream of it, because that one has
 * already translated chunks into AG-UI's vocabulary by the time anything
 * downstream sees them, while a park has to be recognised by B4.run's own
 * `interrupt` chunk — the same signal `handleApStreamRequest` watches for
 * inline. Being upstream also means the flag is set before the enqueue, so a
 * park observed after the client has gone — the controller closed, every write
 * a no-op — still counts.
 */
async function* observeInterrupts(
  chunks: AsyncIterable<StreamChunk>,
  onInterrupt: () => void,
): AsyncGenerator<StreamChunk> {
  for await (const chunk of chunks) {
    if (chunk.type === "interrupt") onInterrupt()
    yield chunk
  }
}

/**
 * Pass-through tap that publishes each raw `StreamChunk` to the live turn
 * BEFORE AG-UI translation, so an attacher on the AP wire sees AP-vocabulary
 * frames rather than encoded AG-UI events. Upstream of `normalizeB4Stream`
 * for the same reason `observeInterrupts` is: once translated, the chunk no
 * longer carries the vocabulary the hub stores. The terminal `done` chunk is
 * captured rather than published — see the `liveTurn?.close` call site for
 * why it is delivered exactly once, never through the digest.
 *
 * What it publishes is the client-facing view (`clientFacingChunk`): an
 * attacher must no more see a client tool park, or a `client_`-prefixed name,
 * than the primary client does. The raw chunk is still yielded downstream,
 * where `normalizeB4Stream` applies the same view exactly once.
 */
async function* tapLiveTurn(
  chunks: AsyncIterable<StreamChunk>,
  liveTurn: LiveTurnProducer | undefined,
  onTerminal: (chunk: StreamChunk) => void,
  clientToolNames: ReadonlySet<string> = new Set(),
): AsyncGenerator<StreamChunk> {
  for await (const chunk of chunks) {
    if (chunk.type === "done") onTerminal(chunk)
    else {
      const visible = clientFacingChunk(chunk, clientToolNames)
      if (visible !== undefined) liveTurn?.publish(visible)
    }
    yield chunk
  }
}

/** Test seam: the live-turn tap, exported only for unit tests. */
export const __tapLiveTurnForTests = tapLiveTurn

/**
 * The name the client registered for a model-visible tool name: `client_<n>`
 * becomes `<n>` only when `<n>` is one of THIS run's client tools, because
 * CopilotKit dispatches a frontend tool by the name it registered. Any other
 * name — a server tool that merely starts with the prefix included — is left
 * alone.
 */
function clientFacingToolName(name: string, clientToolNames: ReadonlySet<string>): string {
  if (!name.startsWith(CLIENT_TOOL_PREFIX)) return name
  const bare = name.slice(CLIENT_TOOL_PREFIX.length)
  return clientToolNames.has(bare) ? bare : name
}

/**
 * The client's view of one raw chunk, shared by every client-facing wire (the
 * AG-UI translation and the live-turn tap), so they cannot drift apart:
 * `undefined` for a client tool park — dropped by its `type` alone, so a
 * malformed one is not passed on as a prompt either — and `client_<n>`
 * un-prefixed on `tool_call`, `tool_result` and `tool_call_args` for this
 * run's client tools. Everything else is returned as is.
 */
function clientFacingChunk(
  chunk: StreamChunk,
  clientToolNames: ReadonlySet<string>,
): StreamChunk | undefined {
  switch (chunk.type) {
    case "interrupt":
      return isClientToolPark((chunk as { readonly data: unknown }).data) ? undefined : chunk
    case "tool_call":
    case "tool_result": {
      const named = chunk as Extract<StreamChunk, { readonly type: "tool_call" | "tool_result" }>
      const name = clientFacingToolName(named.name, clientToolNames)
      return name === named.name ? chunk : { ...named, name }
    }
    case "tool_call_args": {
      // Streamed argument deltas open TOOL_CALL_START ahead of the announce,
      // so they must carry the same client-facing name the announce does.
      const data = (chunk as { readonly data: unknown }).data
      if (!isRecord(data) || typeof data.name !== "string") return chunk
      const name = clientFacingToolName(data.name, clientToolNames)
      return name === data.name ? chunk : { type: chunk.type, data: { ...data, name } }
    }
    default:
      return chunk
  }
}

/**
 * StreamChunk → the AG-UI mapper's vocabulary.
 *
 * Also where a client tool call stops looking like a park: its `interrupt`
 * chunk is dropped here, so `toAguiEvents` never collects it and the turn
 * ends with an ordinary `RUN_FINISHED` — the client runs the tool from the
 * tool-call frames and answers with a `role: "tool"` message next run.
 * `observeInterrupts` sits upstream and still sees it, so the turn is still
 * recorded as parked. Permission parks pass through untouched.
 */
async function* normalizeB4Stream(
  chunks: AsyncIterable<StreamChunk>,
  clientToolNames: ReadonlySet<string> = new Set(),
): AsyncGenerator<B4AgentStreamChunk> {
  for await (const raw of chunks) {
    const chunk = clientFacingChunk(raw, clientToolNames)
    if (chunk === undefined) continue
    switch (chunk.type) {
      case "chunk":
        yield {
          type: "token",
          ...("messageId" in chunk && typeof chunk.messageId === "string"
            ? { messageId: chunk.messageId }
            : {}),
          data: typeof chunk.data === "string" ? chunk.data : String(chunk.data ?? ""),
        }
        break
      case "tool_call": {
        const toolCall = chunk as Extract<StreamChunk, { readonly type: "tool_call" }>
        yield {
          type: "tool_call",
          data: {
            ...(toolCall.id ? { id: toolCall.id } : {}),
            name: toolCall.name,
            input: toolCall.input,
          },
        }
        break
      }
      case "tool_result": {
        const toolResult = chunk as Extract<StreamChunk, { readonly type: "tool_result" }>
        yield {
          type: "tool_result",
          data: {
            ...(toolResult.id ? { id: toolResult.id } : {}),
            name: toolResult.name,
            output: toolResult.output,
          },
        }
        break
      }
      case "done":
        yield {
          type: "done",
          data: (chunk as Extract<StreamChunk, { readonly type: "done" }>).output,
        }
        break
      default:
        yield {
          type: chunk.type,
          data: (chunk as { readonly type: string; readonly data: unknown }).data,
        }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Test seam: the stream normalizer, exported only for unit tests. */
export const __normalizeB4StreamForTests = normalizeB4Stream

export async function handleAgUiFetchRequest(options: AgUiFetchRequestOptions): Promise<Response> {
  const {
    appRoot,
    boot,
    checkpointer,
    clientTools: clientToolRuntime = { ttlMs: DEFAULT_CLIENT_TOOL_TTL_MS },
    config,
    getMemoryStore,
    liveTurnHub,
    middleware,
    middlewareAfter,
    permissionsStore,
    registry,
    resumeClaims,
    approvalGrants = { mode: "off" },
    runRegistry,
    threadAccess,
    threadsStore,
    sandboxManager,
    signal: shutdownSignal,
    staticModules,
    request,
    routeKey,
    streamRoute = streamResolvedRoute,
  } = options

  const requestController = new AbortController()
  const abortRequest = (message: string) => {
    if (!requestController.signal.aborted) requestController.abort(new Error(message))
  }
  const onRequestAborted = () => abortRequest("AG-UI request aborted")
  if (request.signal.aborted) onRequestAborted()
  else request.signal.addEventListener("abort", onRequestAborted, { once: true })

  // Deliberately a manual listener rather than AbortSignal.any: a composed
  // signal is retained for the lifetime of its SOURCE, and the shutdown signal
  // lives as long as the process. With one composition per request that leaks
  // without bound (measured: 92 MB retained per 200k requests on Node 24 — see
  // run-registry.ts for the identical fix applied to the runs registry).
  // releaseSignalListeners() below removes both listeners once the request is
  // done. Every exit path releases it: the try/finally around the pre-stream
  // work covers the early returns, and once the stream is constructed,
  // ownership passes to its own finally/cancel.
  const onShutdown = () => abortRequest("Server shutting down")
  if (shutdownSignal.aborted) onShutdown()
  else shutdownSignal.addEventListener("abort", onShutdown, { once: true })
  const signal = requestController.signal
  const releaseSignalListeners = () => {
    shutdownSignal.removeEventListener("abort", onShutdown)
    request.signal.removeEventListener("abort", onRequestAborted)
  }

  let releaseResumeClaim: (() => void) | undefined
  let releaseRunBeforeStream: (() => void) | undefined
  let claimTransferredToStream = false
  let runTransferredToStream = false
  let streamOwnsSignalCleanup = false
  try {
    // Bounded: every AG-UI client resends the whole history on every run, so
    // the ceiling is generous (AGUI_BODY_MAX_BYTES), but it is a ceiling.
    let raw: string
    try {
      raw = await readBoundedText(request, AGUI_BODY_MAX_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return payloadTooLarge(error)
      throw error
    }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      return Response.json(createRequestErrorBody("Malformed body"), {
        status: 400,
      })
    }

    const parsed = RunAgentInputSchema.safeParse(parsedJson)
    if (!parsed.success) {
      return Response.json(createRequestErrorBody("Invalid RunAgentInput"), {
        status: 400,
      })
    }
    // The schema's inferred output spells optionals as `T | undefined`; the
    // generated `RunAgentInput` spells them as absent-or-present. Same wire
    // shape — the parse already validated it — so the assertion only
    // reconciles the two spellings under exactOptionalPropertyTypes.
    const input = parsed.data as RunAgentInput

    const route = registry.lookup(routeKey)
    if (!route) {
      return Response.json(createRequestErrorBody(`Unknown route: ${routeKey}`), { status: 404 })
    }

    // BEFORE route middleware and BEFORE the thread-access gate, and in that
    // order on purpose. The envelope check needs no I/O, takes no claim, reads
    // no thread row and discloses nothing about one — it judges only what this
    // caller sent about itself. Running it first means an app's middleware is
    // never handed an envelope the runtime has already decided not to honor,
    // and a thread-access policy is never asked to authorize (or stamp a new
    // row for) a request that is about to be rejected anyway. It cannot leak
    // thread existence, because it never looks.
    const envelopePolicy = resolveRunEnvelopePolicy(config ?? boot?.config, route.routeId)
    const envelopeRejection = validateRunEnvelope(parsedJson, envelopePolicy)
    if (envelopeRejection) {
      return Response.json(
        createRequestErrorBody(
          envelopeRejection.message,
          { code: envelopeRejection.code },
          { code: "B4_E5401" },
        ),
        { status: envelopeRejection.status },
      )
    }

    // The client's response schema (Hashbrown's `hashbrown.responseSchema`),
    // read off the ORIGINAL JSON because `RunAgentInputSchema` strips the key.
    // Malformed is judged here, before middleware, from the body alone; whether
    // the ROUTE can honor it is judged below, after middleware has admitted
    // the caller and before any side effect. Never ignored: see response-schema.ts.
    const responseSchema = readResponseFormat(parsedJson)
    if (!responseSchema.ok) {
      return Response.json(
        createRequestErrorBody(
          responseSchema.message,
          { code: responseSchema.code },
          { code: "B4_E5402" },
        ),
        { status: responseSchema.status },
      )
    }
    const responseFormat = responseSchema.responseFormat

    // The caller's client tool definitions, bounded and validated from the
    // ORIGINAL JSON, like the envelope. Only on a route that opted in: for any
    // other, a non-empty `tools` was already refused above, and an empty one
    // carries nothing.
    let requestClientTools: readonly ClientToolDefinition[] = []
    const rawTools = isRecord(parsedJson) ? parsedJson.tools : undefined
    if (envelopePolicy.clientTools && Array.isArray(rawTools) && rawTools.length > 0) {
      const read = readClientToolDefinitions(rawTools)
      if (!read.ok) {
        return Response.json(
          createRequestErrorBody(read.message, { code: read.code }, { code: "B4_E5401" }),
          { status: read.status },
        )
      }
      requestClientTools = read.tools
    }

    const requestUrl = new URL(request.url)
    const b4Input = fromRunAgentInput(input)
    // The one place this turn decides it is a resume. Computed HERE, above
    // every gate site, because this endpoint gates up to twice per request and
    // a turn that reported `resuming: true` at one gate and `false` at another
    // would be describing two different requests. `fromRunAgentInput` leaves
    // `resume` undefined for an absent OR empty array, so this is exactly the
    // condition the resume claim below takes itself on.
    //
    // A trailing `role: "tool"` message is the other resume: it is how a
    // client answers a parked client tool call. Judged from the request SHAPE
    // alone, as `resuming` is everywhere — whether it really answers a park
    // takes a checkpoint read, and that read must not happen before the
    // thread-access gate (it would make the policy's decision an oracle on
    // someone else's thread). Counted on EVERY route, opted in or not:
    // over-reporting a resume only holds the request to a policy's higher
    // bar, while under-reporting one would let it skip that bar.
    const trailingToolMessage = b4Input.messages.at(-1)?.role === "tool"
    const resuming = b4Input.resume !== undefined || trailingToolMessage
    const middlewareRequest: MiddlewareRequest = {
      ...(middleware ? { body: structuredClone(parsedJson) } : {}),
      assistantId: route.assistantId,
      headers: headersToRecord(request.headers),
      method: request.method,
      params: extractRouteParams(route.routeId, b4Input.raw),
      routeId: route.routeId,
      url: `${requestUrl.pathname}${requestUrl.search}`,
    }
    const middlewareResult = await runMiddleware(middleware, middlewareRequest)
    if (middlewareResult.action === "reject") {
      return statusResponse(middlewareResult.status, middlewareResult.body)
    }

    // Can this route's root model be bound to the schema? Decided here — after
    // middleware, so an unauthenticated caller learns nothing about the route,
    // and before the thread gate, so a rejected run claims no slot, creates no
    // row and starts no stream. The route module load this needs is the same
    // memoized one the run would do. A non-agent assistant id is settled off
    // the registry entry alone; the provider needs the descriptor, which the
    // boot fallbacks load (a caller without them — a direct embedder — still
    // gets the same rejection from `streamResolvedRoute`, as a RUN_ERROR).
    if (responseFormat) {
      const unsupported =
        route.mode !== "agent"
          ? {
              ok: false as const,
              message: nonAgentResponseFormatMessage(route.routeId, route.mode),
            }
          : boot?.bootFallbacks
            ? await checkRouteResponseFormatSupport({
                appRoot,
                bootFallbacks: boot.bootFallbacks,
                routeFile: route.routeFile,
                routeId: route.routeId,
              })
            : { ok: true as const }
      if (!unsupported.ok) {
        const rejection = rejectResponseSchema("response_schema_not_supported", unsupported.message)
        return Response.json(
          createRequestErrorBody(rejection.message, { code: rejection.code }, { code: "B4_E5402" }),
          { status: rejection.status },
        )
      }
    }

    // Can this route take the client's tools, and is there anywhere to record
    // the calls? Same placement and reasoning as the response-schema check:
    // after middleware, before the thread gate and every side effect.
    if (requestClientTools.length > 0) {
      const unsupported =
        route.mode !== "agent"
          ? {
              ok: false as const,
              message: nonAgentClientToolsMessage(route.routeId, route.mode),
            }
          : boot?.bootFallbacks
            ? await checkRouteClientToolsSupport({
                appRoot,
                bootFallbacks: boot.bootFallbacks,
                routeFile: route.routeFile,
                routeId: route.routeId,
              })
            : { ok: true as const }
      if (!unsupported.ok) {
        return Response.json(
          createRequestErrorBody(
            unsupported.message,
            { code: "client_tools_not_supported" },
            { code: "B4_E5401" },
          ),
          { status: 422 },
        )
      }
      if (!clientToolRuntime.store) return clientToolStoreUnavailable()
    }

    // `update` on a row that exists, `create` on one this turn is about to
    // make — see ThreadOperation. AFTER the middleware reject above and BEFORE
    // every side effect below (`resumeClaims.tryClaim`, `runRegistry.begin`,
    // `threadsStore.createThread`): a denial must take no claim, no run slot,
    // and create no row. This route has no `threads` segment — the
    // client-supplied `input.threadId` is the only thread identity a caller
    // controls here, and it names any thread id it likes.
    //
    // The create itself lands below, once `resolvePendingResume` has run — but
    // BEFORE `runRegistry.begin`, so a caller the row recheck ultimately denies
    // never holds the victim thread's run slot for the width of that recheck.
    // These two carry the `create` decision down to it. Both stay `undefined` on
    // a row that already exists and on a hook-less app, which is what the create
    // site branches on.
    let createGate: ((spec: GateSpec) => Gate | Promise<Gate>) | undefined
    let createStamp: Record<string, unknown> | undefined
    if (threadAccess) {
      const existing = await threadsStore.getThread(input.threadId)
      const gate = makeThreadGate(threadAccess, request)
      const g = gate({
        action: existing ? "update" : "create",
        operation: "run.agui",
        resuming,
        threadId: input.threadId,
        ...(existing ? { thread: existing } : {}),
      })
      const settled = isThenable(g) ? await g : g
      if (!settled.ok) return settled.response
      if (!existing) {
        createGate = gate
        createStamp = settled.stamp
      }
    }

    // ── Serialization ────────────────────────────────────────────────────
    //
    // A resume — an approval resume, or a trailing tool message on a
    // client-tools route — takes the thread's resume claim BEFORE it reads the
    // pending snapshot it decides on. So does any turn on a thread with a
    // client park pending: the client-tool decision answers records in the
    // store, and two requests deciding over the same parks at once could
    // answer one and resume with the other's view. The snapshot read before
    // such a claim is only a peek; the decision uses the one read after it.
    //
    // The run slot (`runRegistry.begin`) is taken later, as before, so a
    // request can answer a record and then lose the slot to a run still
    // draining (409 `run_in_flight`). That is safe: an answer is single-use
    // and durable, and the client's retry resends the same history, which
    // finds the record answered and resumes with the stored result.
    const takeResumeClaim = (): Response | undefined => {
      releaseResumeClaim = resumeClaims.tryClaim(input.threadId)
      if (releaseResumeClaim) return undefined
      return Response.json(
        createRequestErrorBody("A resume is already in progress for this thread", {
          code: "resume_in_progress",
        }),
        { status: 409 },
      )
    }
    const readSnapshot = async (): Promise<PendingInterruptSnapshot> =>
      (await readPendingInterrupts(checkpointer, input.threadId)) ?? {
        interrupts: [],
        malformed: false,
      }
    if (resuming) {
      const refused = takeResumeClaim()
      if (refused) return refused
    }
    let snapshot = await readSnapshot()
    if (!releaseResumeClaim && snapshot.interrupts.some((park) => isClientToolPark(park.value))) {
      const refused = takeResumeClaim()
      if (refused) return refused
      snapshot = await readSnapshot()
    }

    const newestUserMessage = [...b4Input.messages]
      .reverse()
      .find((message) => message.role === "user")
    const threadId = input.threadId

    // ── Client tool parks ────────────────────────────────────────────────
    //
    // Matched against the retained record by `resolveClientToolTurn`, over the
    // FULL snapshot. Never without a store: a park nobody can match is refused
    // rather than guessed at.
    const clientParks = snapshot.interrupts.filter((park) => isClientToolPark(park.value))
    const approvalParksOnly = withoutClientToolParks(snapshot)
    const trailingUserMessage = b4Input.messages.at(-1)?.role === "user"
    let clientTurn: ClientToolTurn = { mode: "none" }
    // Only the route that ISSUED a client call may answer or resume it:
    // resuming another route's park on this route's graph would run it with
    // the wrong prompt, tools and middleware, and let a caller admitted only
    // to this route supply that route's result. Judged from each call's
    // record, whose `routeId` is written while the call is issued — before
    // the client can see it, so never behind the park (the thread's
    // `parked_route` is written only once the turn has settled). Read BEFORE
    // anything is stored, under the claim the snapshot was read under. A
    // park with no record at all is answerable by no route (the resolver
    // finds it unanswerable), so it does not make the request foreign.
    let foreignClientPark = false
    if (clientParks.length > 0 && envelopePolicy.clientTools) {
      const store = clientToolRuntime.store
      if (!store) return clientToolStoreUnavailable()
      const parkedIds = clientToolCallIds(clientParks)
      foreignClientPark = (await store.listForThread(threadId)).some(
        (row) => parkedIds.has(row.toolCallId) && row.routeId !== routeKey,
      )
    }
    const answersHere = clientParks.length > 0 && envelopePolicy.clientTools && !foreignClientPark
    if (clientParks.length > 0 && !answersHere) {
      // A client park this route may not answer: the route does not (or no
      // longer does) take client tools, or another route issued it. This
      // route never answers, resumes or re-offers a client call, so a
      // trailing tool message stays refused. A new user
      // message abandons the parked calls exactly as on an opted-in route,
      // or the thread would be a dead end. A permission park pending
      // alongside stays refused too: it could only be resumed together with
      // the client calls (never partially), which this route cannot do.
      if (!trailingUserMessage || approvalParksOnly.interrupts.length > 0) {
        return clientToolPending()
      }
      const store = clientToolRuntime.store
      if (!store) return clientToolStoreUnavailable()
      // Tool messages are withheld from the resolver, so it answers nothing:
      // the calls it returns carry each STORED result (answered before, on
      // an opted-in run) or ABANDONED_CLIENT_TOOL_RESULT — never content
      // from this request. With a trailing user message it always abandons.
      clientTurn = await resolveClientToolTurn({
        store,
        threadId: input.threadId,
        pending: snapshot,
        messages: b4Input.messages.filter((message) => message.role !== "tool"),
        now: new Date(),
      })
      if (clientTurn.mode !== "abandon") return clientToolPending()
    } else if (answersHere) {
      const store = clientToolRuntime.store
      if (!store) return clientToolStoreUnavailable()
      const now = new Date()
      const sized = await screenOversizedClientToolResults(
        store,
        threadId,
        clientParks,
        b4Input.messages,
        now,
      )
      if (sized.refused) return sized.refused
      clientTurn = await resolveClientToolTurn({
        store,
        threadId,
        pending: snapshot,
        messages: sized.messages,
        now,
      })
    }
    // Abandoning: the parked client calls are closed in the checkpoint under
    // the run slot (below), then this request's turn runs. A permission park
    // pending alongside must be answered first — the close writes as the
    // `tools` node, which would skip it — exactly as the approval flow
    // refuses a new turn over a pending prompt.
    if (clientTurn.mode === "abandon" && approvalParksOnly.interrupts.length > 0) {
      return Response.json(
        createRequestErrorBody(
          "Pending interrupts must be resumed before a parked client tool call can be abandoned",
          { code: "resume_required" },
        ),
        { status: 409 },
      )
    }
    // After a close with no new user message (the call expired, or its park
    // is unanswerable, while the client's last message was a tool message),
    // the turn continues from the closed checkpoint so the model replies to
    // the closed calls. Judged by the trailing message rather than the
    // abandon reason: an expired call plus a new user message runs that
    // message, it is never dropped.
    const continueAfterClose = clientTurn.mode === "abandon" && !trailingUserMessage
    if (
      clientTurn.mode === "none" &&
      envelopePolicy.clientTools &&
      trailingToolMessage &&
      b4Input.resume === undefined &&
      approvalParksOnly.interrupts.length === 0 &&
      !approvalParksOnly.malformed
    ) {
      // A trailing tool message that answers nothing pending: resent history
      // (a client retrying a run that already resumed), or a forgery. It
      // carries no new user input, so there is no turn to run — re-running
      // the last user message would answer it twice. Same no-op as `partial`,
      // which makes client retries idempotent.
      return clientToolPartialResponse(threadId, input.runId, request.headers.get("accept"))
    }
    if (clientTurn.mode === "partial") {
      // Some parked calls answered, others not yet: the results are recorded,
      // the graph is not touched, and the run ends as an ordinary success so
      // the client goes on to send the rest.
      return clientToolPartialResponse(threadId, input.runId, request.headers.get("accept"))
    }

    // The permission parks this run must resolve through the envelope's
    // `resume` entries: every non-client park. On a client resume these are
    // the resolver's `others`, and they resolve in the SAME Command as the
    // client results — never partially: a partial resume leaves the answered
    // park's `__interrupt__` write in the checkpoint until the superstep
    // completes, so it is re-demanded, and re-runs the unanswered task. See
    // `handleResumeRequest`, which refuses outright (`client_tool_pending`)
    // for the same reason.
    //
    // On an abandon nothing but the client parks is pending (refused above
    // otherwise), and a malformed client envelope is the close's business,
    // not the resume's: only the parser's own malformed flag carries over.
    const pending: PendingInterruptSnapshot =
      clientTurn.mode === "resume"
        ? { interrupts: clientTurn.others, malformed: snapshot.malformed }
        : clientTurn.mode === "abandon"
          ? { interrupts: [], malformed: snapshot.malformed }
          : approvalParksOnly
    const resumeResolution = resolvePendingResume(b4Input.resume, pending)
    if (!resumeResolution.ok) {
      return Response.json(
        createRequestErrorBody(resumeResolution.message, {
          code: resumeResolution.code,
        }),
        { status: resumeResolution.status },
      )
    }

    // An approval decision is answered only on the route that parked it. The
    // Agent Protocol resume endpoint resolves its route from server state and
    // never lets the caller choose; here the route comes from the URL, so
    // without this a caller admitted to a weaker route could answer — and run
    // under that route's graph, prompt and tools — an approval parked under a
    // stronger one. The owner is `parked_route`, or `metadata.route` (written
    // when the turn started) when settle has not recorded the park yet: the
    // same chain the Agent Protocol endpoints gate on. After the thread-access
    // gate and the claim, before any grant is checked or consumed; the owner is
    // never echoed. Client tool results are bound separately, on their record.
    //
    // Residual, deliberately accepted: with NO owner recorded (no thread row —
    // e.g. a durable checkpointer behind an in-memory threads store after a
    // restart — or a park by a build that predates the route key) there is
    // nothing to bind to, and the requested route is used, exactly as
    // /threads/:id/resume falls back to the caller's `route`. Refusing would
    // leave such approvals unanswerable forever.
    if (resumeResolution.mode === "resume") {
      const owningThread = await threadsStore.getThread(threadId)
      const persistedRoute = owningThread?.metadata.route
      const owningRoute =
        readParkedRoute(owningThread) ??
        (typeof persistedRoute === "string" ? persistedRoute : undefined)
      if (owningRoute !== undefined && owningRoute !== routeKey) {
        return Response.json(
          createRequestErrorBody(
            "This thread's pending approval belongs to another route; resume it on the route that parked it.",
            { code: "resume_route_mismatch" },
          ),
          { status: 409 },
        )
      }
    }

    const approvalGrantMinter = minterFor(approvalGrants, threadId)

    // Grant checks run HERE: after the thread-access gate, after the resume
    // claim, and after the exact-set match — never before them, or the
    // distinct grant codes become an oracle on a victim's parked set, which is
    // exactly what the gate-before-tryClaim ordering exists to prevent.
    // Consumes on success, immediately before the resume reaches the graph.
    if (b4Input.resume && b4Input.resume.length > 0) {
      const refused = await gateResumeWithGrants({
        grants: approvalGrants,
        threadId,
        pending: pending.interrupts,
        entries: b4Input.resume,
      })
      if (refused) return refused
    }

    // ONE resume map for every pending park: the client results keyed by
    // their resumeKey, plus the approval decisions for the rest.
    const routeResume: RouteResumePayload | undefined =
      clientTurn.mode === "resume"
        ? {
            ...clientTurn.resume,
            ...(resumeResolution.mode === "resume" ? resumeResolution.resume : {}),
          }
        : continueAfterClose
          ? CONTINUE_AFTER_CLOSE
          : resumeResolution.mode === "resume"
            ? resumeResolution.resume
            : undefined

    // This run's client tools: the request's, plus a stub for every parked
    // call being resumed whose tool the request did not (re)send — a
    // follow-up that omits `tools` must still resume the stub that parked.
    const runClientTools = withParkedClientTools(
      requestClientTools,
      clientTurn.mode === "resume" ? clientParks : [],
    )
    const clientToolStore = clientToolRuntime.store
    // The calls this request resumes: the only ones whose ANSWERED record
    // may still stand behind a replayed stub.
    const resumingToolCallIds: ReadonlySet<string> =
      clientTurn.mode === "resume" ? clientToolCallIds(clientParks) : new Set()
    const clientToolRecorder: ClientToolRecorder | undefined =
      runClientTools.length > 0 && clientToolStore
        ? {
            // A replay only for a live record: outstanding, or answered and
            // being resumed by THIS request. A provider that reuses an id
            // whose record was answered (and resumed) or voided long ago is
            // making a NEW call, which must not park against that record —
            // its stored result would be resumed as this call's answer.
            has: async (toolCallId) => {
              const row = await clientToolStore.get(threadId, toolCallId)
              if (!row || row.voidedAt !== null) return false
              return row.answeredAt === null || resumingToolCallIds.has(toolCallId)
            },
            // `issue` is a no-op on an existing key, so a NEW call whose id
            // already has a record cannot be recorded; it fails instead of
            // parking on a record it does not own. The stub's tool call then
            // errors — nothing parks. Fixed message: never echoes the id.
            record: async (call) => {
              if (await clientToolStore.get(threadId, call.toolCallId)) {
                throw new Error(
                  "This client tool call id was already used on this thread; the call was not made.",
                )
              }
              const issued = new Date()
              await clientToolStore.issue({
                threadId,
                toolCallId: call.toolCallId,
                interruptId: call.interruptId,
                toolName: call.toolName,
                runId: input.runId,
                routeId: routeKey,
                issuedAt: issued.toISOString(),
                expiresAt: new Date(issued.getTime() + clientToolRuntime.ttlMs).toISOString(),
                answeredAt: null,
                result: null,
                voidedAt: null,
              })
            },
          }
        : undefined
    // Un-prefixed names, shared by both client-facing wires so an attacher and
    // the primary client see the same names.
    const clientToolNames: ReadonlySet<string> = new Set(runClientTools.map((tool) => tool.name))

    // Authorize — and, when this turn must, create — the concrete row BEFORE
    // claiming the run slot, mirroring the Agent Protocol run handlers. Doing it
    // after `runRegistry.begin` (where it used to sit) let a caller the recheck
    // ultimately denies hold the victim thread's slot for the width of that
    // recheck: a client-chosen id means the row that turned up may be anybody's,
    // and a denied caller would brick a concurrent authorized run on the same
    // thread with a transient `run_in_flight` 409. Read once here; only the
    // CLEAR consults `previousParkedRoute`, with the same staleness caveat the
    // Agent Protocol handlers carry.
    const existingThread = await threadsStore.getThread(threadId)
    const previousParkedRoute = readParkedRoute(existingThread)
    if (createGate && existingThread) {
      // A row appeared between the gate and here. The window still exists — a
      // resume claim and a checkpointer read sit inside it — and the id is
      // client-chosen, so the row that turned up may be anybody's. The `create`
      // decision authorized a thread that did not exist; this one does, so it is
      // authorized as what it now is. Skipping this on the strength of the
      // earlier decision would run the turn on a thread nothing admitted this
      // caller to.
      const recheck = createGate({
        action: "update",
        operation: "run.agui",
        resuming,
        thread: existingThread,
        threadId,
      })
      const settled = isThenable(recheck) ? await recheck : recheck
      if (!settled.ok) return settled.response
    } else if (createGate) {
      // No row under this id: a staged workspace recorded for it is stale (see the run
      // endpoints), and a new thread must not inherit it.
      sandboxManager?.forgetStagedWorkspace(threadId)
      const created = await createGatedThreadForRun({
        gate: createGate,
        operation: "run.agui",
        resuming,
        stamp: createStamp,
        store: threadsStore,
        threadId,
      })
      if (!created.ok) return created.response
    } else if (!existingThread) {
      // Hook-less: unchanged, but for forgetting a stale staged workspace.
      sandboxManager?.forgetStagedWorkspace(threadId)
      await threadsStore.createThread({ thread_id: threadId })
    }

    const run = runRegistry.begin(threadId, signal)
    if (!run) {
      return Response.json(
        createRequestErrorBody(`A run is already in flight for thread "${threadId}"`, {
          code: "run_in_flight",
        }),
        { status: 409 },
      )
    }
    releaseRunBeforeStream = run.release

    // A request that decided on a snapshot with NO client park may be about
    // to run a new turn past one that appeared since: a run still executing
    // when the snapshot was read can park a client tool call and release its
    // slot before this `begin`. Holding the resume claim does not prevent
    // that — the parking run never took the claim — so the recheck follows
    // the decision, not the claim. Re-read under the run slot and refuse;
    // the outer finally releases the slot.
    if (clientParks.length === 0) {
      const recheck = await readSnapshot()
      if (recheck.interrupts.some((park) => isClientToolPark(park.value))) {
        return clientToolPending()
      }
    }

    // The route-execution instances, shared by the abandon's close and the
    // turn, so the close materializes the parked route exactly as a turn
    // prepares it — on a runtime without node fallbacks too.
    const routeInstances = {
      ...boot,
      checkpointer,
      ...(getMemoryStore ? { memoryStore: getMemoryStore } : {}),
      ...(permissionsStore ? { permissionsStore } : {}),
      ...(registry.manifest ? { routeManifest: registry.manifest } : {}),
      ...(sandboxManager ? { sandboxManager } : {}),
      ...(staticModules ? { staticModules } : {}),
      threadId,
      threadsStore,
    }

    // The abandon's close, under the run slot (and the resume claim every
    // client-park request holds), then the void — only once the checkpoint
    // no longer holds the parks, so a failed close leaves every record
    // exactly as it was. The outer finally releases the slot and the claim
    // on each refusal.
    if (clientTurn.mode === "abandon") {
      const refused = await closeAbandonedClientParks({
        appRoot,
        calls: clientTurn.calls,
        clientParks,
        currentRouteKey: routeKey,
        instances: routeInstances,
        store: clientToolStore,
        middlewareContext: middlewareResult.context,
        registry,
        signal: run.signal,
      })
      if (refused) return refused
      if (clientTurn.abandonedToolCallIds.length > 0 && clientToolStore) {
        try {
          await clientToolStore.voidOutstanding({
            threadId,
            toolCallIds: clientTurn.abandonedToolCallIds,
            at: new Date().toISOString(),
          })
        } catch (error) {
          // The parks are already closed, so the turn runs; a record left
          // outstanding is voided when this turn settles without parking.
          console.warn(`B4: could not void abandoned client tool calls for ${threadId}.`, error)
        }
      }
    }

    // Live-turn anchor: one latest-tuple read, taken before the route stream
    // begins executing so it races nothing the run itself writes. A failed
    // read degrades attach to the durable path for this turn — it must never
    // fail the run or leak the run slot, so the failure is only logged.
    let liveTurn: LiveTurnProducer | undefined
    try {
      const anchorTuple = await checkpointer.getTuple({
        configurable: { checkpoint_ns: "", thread_id: threadId },
      })
      liveTurn = liveTurnHub.open({
        routeKey,
        anchorRouteKeys: checkpointRoutes(anchorTuple) ?? [],
        anchorCheckpointId: anchorTuple?.checkpoint?.id ?? null,
        input: routeResume ?? b4Input,
        resume: routeResume !== undefined,
        runStartedAt: new Date().toISOString(),
        threadId,
      })
    } catch (error) {
      console.warn(
        `B4: live-turn anchor read failed for ${threadId}; attach degrades to the durable path.`,
        error,
      )
    }

    // The last-run route, and therefore NOT the identity
    // GET /threads/:id/pending_interrupts gates on — any run the caller is
    // allowed to start overwrites it. See PARKED_ROUTE_KEY. This endpoint is the
    // one the CopilotKit UIs drive, so it is where most parks are born; a park
    // it failed to record would be a park that endpoint could not protect.
    const routePatch = { route: routeKey }
    // See the same guard in runtime-fetch-core.ts: the metadata merge is
    // shallow, so nothing the runtime writes may carry the access stamp's key.
    assertNoReservedKey(routePatch)
    try {
      await threadsStore.updateMetadata(threadId, routePatch)
      await threadsStore.updateStatus(threadId, "busy")
    } catch (error) {
      // The live-turn entry cannot leak open with the run slot about to be
      // released by the outer `finally` below: a viewer that raced this
      // failure gets a terminal frame instead of a hanging heartbeat.
      liveTurn?.close({ output: { error: String(error) }, type: "done" })
      throw error
    }

    const accept = request.headers.get("accept") ?? undefined
    const encoder = new TextEncoder()
    const releaseClaimWhenSettled = releaseResumeClaim
    let sourceCleanup: Promise<void> | undefined
    // A parked turn takes the NORMAL completion path — the adapter yields the
    // interrupt chunk and then `done` — so a drained loop does not mean the turn
    // finished. The handler's own flag, so parked-status honesty depends on
    // nothing outside this request.
    //
    // This is the change #443's note about the "idle" status write being
    // "deliberately left alone (tracked separately)" was pointing at; that note
    // is gone because this is the separate tracking, landed.
    let sawInterrupt = false
    // Capture the raw done, or project AG-UI's caught failure/cancellation
    // back into an AP terminal. The finally delivers it once to attachers,
    // without adding a terminal frame to the live turn's digest.
    let terminalChunk: StreamChunk | undefined
    // A turn that settled without parking leaves no client call waiting: void
    // any record still outstanding (one whose void failed after a close, or a
    // stray), keeping only a call whose park is still in the checkpoint — a
    // park the stream could not see must stay answerable.
    let deferClientRecordVoid = false
    const voidClientRecordsIfSettled = async (): Promise<void> => {
      if (!sawInterrupt && clientToolStore) {
        await voidSettledClientToolCalls(clientToolStore, checkpointer, threadId)
      }
    }
    // From here on, the stream owns both the request listeners and any resume
    // claim. Its execution-finally path releases the claim only after the
    // interrupted route has actually unwound.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          try {
            const routeStream = streamRoute({
              appRoot,
              ...routeInstances,
              input: {
                messages:
                  newestUserMessage && !continueAfterClose
                    ? [{ role: "user", content: newestUserMessage.content }]
                    : [],
              },
              ...(routeResume ? { resume: routeResume } : {}),
              ...(responseFormat ? { responseFormat } : {}),
              ...(runClientTools.length > 0 ? { clientTools: runClientTools } : {}),
              ...(clientToolRecorder ? { clientToolRecorder } : {}),
              // Injected into config.configurable by the agent-adapter, for the
              // park site to read. `undefined` when grants are off or no store
              // resolved — never a no-op minter, which would satisfy the park
              // site's presence check and park without a grant.
              ...(approvalGrantMinter ? { approvalGrantMinter } : {}),
              ...(middlewareResult.context ? { middlewareContext: middlewareResult.context } : {}),
              routeFile: route.routeFile,
              routeId: route.routeId,
              routePath: route.routePath,
              signal: run.signal,
            })
            const abortableRouteStream = abortableAsyncIterable(
              routeStream,
              run.signal,
              (cleanup) => {
                sourceCleanup = cleanup
              },
            )
            const observedRouteStream = observeInterrupts(abortableRouteStream, () => {
              sawInterrupt = true
            })
            // Upstream of the live-turn tap and of AG-UI translation, so an
            // attacher and the primary client see the same final message, and
            // a rejection reaches both as the terminal error.
            const guardedRouteStream = middlewareAfter
              ? applyMiddlewareAfter(observedRouteStream, middlewareAfter, {
                  assistantId: route.assistantId,
                  context: middlewareResult.context,
                  messages: b4Input.messages.map(toAfterMessage),
                  routeId: route.routeId,
                  runId: input.runId,
                  threadId,
                })
              : observedRouteStream
            const liveTappedStream = tapLiveTurn(
              guardedRouteStream,
              liveTurn,
              (chunk) => {
                terminalChunk = chunk
              },
              clientToolNames,
            )
            for await (const event of toAguiEvents(
              normalizeB4Stream(liveTappedStream, clientToolNames),
              {
                threadId,
                runId: input.runId,
              },
            )) {
              // The translator catches upstream errors and aborts as RUN_ERROR,
              // so the raw stream may never produce a terminal chunk. Preserve
              // that outcome for AP viewers instead of reporting null success.
              if (event.type === "RUN_ERROR" && terminalChunk === undefined) {
                terminalChunk = {
                  type: "done",
                  output: run.cancelled ? { cancelled: true } : { error: event.message },
                }
              }
              safeEnqueue(controller, encoder.encode(encodeAgUiSse(event, accept)))
            }
          } finally {
            // Unconditional, same as handleApStreamRequest: attachers must see
            // the terminal frame exactly when the primary client does. The
            // identity guard inside `close` means a zombie route can never
            // write into a successor turn that has already replaced this
            // entry.
            liveTurn?.close(terminalChunk ?? { output: null, type: "done" })
            // This finally covers BOTH the drained and the failed turn, which is
            // exactly the pair the Agent Protocol handlers cover with a
            // success-path call plus a catch-path retry: a turn that parked
            // before failing is still parked. Errors are swallowed rather than
            // propagated because throwing from here would replace whatever
            // error brought us into the finally, masking the real failure.
            await settleParkedRoute({
              // Exactly as the Agent Protocol handlers: only when grants are
              // on, and never able to fail the turn.
              ...(approvalGrants.mode === "off"
                ? {}
                : {
                    voidGrants: async (stillPending) => {
                      await voidSupersededGrants({
                        ...(approvalGrants.store ? { store: approvalGrants.store } : {}),
                        threadId,
                        stillPending,
                      })
                    },
                  }),
              canPark: route.mode === "agent",
              checkpointer,
              parked: sawInterrupt,
              previousParkedRoute,
              routeKey,
              threadId,
              threadsStore,
            }).catch(() => undefined)
            // A turn that settled without parking leaves no client call
            // waiting: void any record still outstanding (one whose void
            // failed after a close, or a stray), keeping only a call whose
            // park is still in the checkpoint — a park the stream could not
            // see (see the status note below) must stay answerable.
            // Only once the route source has settled. A drained or failed
            // source has; an ABORTED one may still be unwinding (see
            // `sourceCleanup`) and may yet land a park whose record it already
            // issued, so that case voids on the release path below instead.
            deferClientRecordVoid = run.signal.aborted
            if (!deferClientRecordVoid) await voidClientRecordsIfSettled()
            // One write covers the drained turn, the failed one and the
            // disconnected one, because `toAguiEvents` never throws into its
            // consumer: an upstream error or abort arrives as a RUN_ERROR event
            // and the loop above ends normally. All three want the same answer —
            // a turn that parked and then failed, or parked and then lost its
            // client, is still parked.
            //
            // Deliberately not `run.cancelled`. AG-UI ends the run when the
            // client goes away, and a disconnect leaves nothing durable to come
            // back to, so it is not an interruption; what survives a disconnect
            // is the park, which this already reports.
            //
            // Bounded by what the stream can see: a client that disconnects
            // mid-superstep can abort the route after LangGraph has durably
            // written `__interrupt__` but before the adapter yields the chunk
            // for it, and that park still reads back as idle. Closing that needs
            // a checkpoint read here rather than a flag.
            await threadsStore
              .updateStatus(threadId, terminalStatus({ cancelled: false, sawInterrupt }))
              .catch(() => undefined)
            releaseSignalListeners()
          }
          safeClose(controller)
        } catch (error) {
          // Mirrors the pre-refactor behavior: a mid-stream failure propagated
          // out of the handler after headers were sent, tearing the stream down
          // rather than framing an error event.
          controller.error(error)
        } finally {
          const releaseExecutionClaims = () => {
            run.release()
            releaseClaimWhenSettled?.()
          }
          if (deferClientRecordVoid) {
            // The slot is held until the void is done, so no successor run
            // can race it; the void itself never throws.
            void (sourceCleanup ?? Promise.resolve())
              .then(voidClientRecordsIfSettled, voidClientRecordsIfSettled)
              .finally(releaseExecutionClaims)
          } else if (sourceCleanup) void sourceCleanup.finally(releaseExecutionClaims)
          else releaseExecutionClaims()
        }
      },
      cancel() {
        // AG-UI is ephemeral: a disconnected client ends the run. The start
        // finally releases any resume claim after execution settles.
        abortRequest("AG-UI response closed")
        releaseSignalListeners()
      },
    })

    claimTransferredToStream = true
    runTransferredToStream = true
    streamOwnsSignalCleanup = true
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      },
      status: 200,
    })
  } finally {
    // Failures before stream ownership transfers must not leave the thread
    // claimed. Successful streams release from their execution-finally path.
    if (!claimTransferredToStream) releaseResumeClaim?.()
    if (!runTransferredToStream) releaseRunBeforeStream?.()
    if (!streamOwnsSignalCleanup) releaseSignalListeners()
  }
}

/**
 * Node-transport adapter over {@link handleAgUiFetchRequest}. Kept with its
 * original `(IncomingMessage, ServerResponse)` signature for direct callers.
 */
export async function handleAgUiRequest(options: AgUiRequestOptions): Promise<void> {
  const { request, response, ...rest } = options
  const webResponse = await handleAgUiFetchRequest({
    ...rest,
    request: toWebRequest(request, response),
  })
  await writeNodeResponse(response, webResponse)
}

function clientToolPending(): Response {
  return Response.json(
    createRequestErrorBody(
      "A client tool call is pending on this thread, and this request can neither answer nor abandon it.",
      { code: "client_tool_pending" },
    ),
    { status: 409 },
  )
}

/** The provider tool-call ids of these client parks (envelopes that carry one). */
function clientToolCallIds(parks: readonly PendingInterrupt[]): ReadonlySet<string> {
  return new Set(
    parks.flatMap((park) => (isClientToolCallEnvelope(park.value) ? [park.value.toolCallId] : [])),
  )
}

/**
 * Close the parked client calls in the checkpoint, on a graph materialized
 * for the route that ISSUED them, with a stub for each parked call, bound to
 * the thread's checkpointer. That route is the one on the parks' records,
 * re-read under the run slot: they must agree on one. Only when no parked
 * call has a record at all (an unanswerable park) does the thread's
 * `parked_route` stand in — the close itself still verifies every call.
 * Returns a refusal, or `undefined` once closed. Every message is fixed: no
 * id, name or result from the request (or the store) is echoed.
 */
async function closeAbandonedClientParks(options: {
  readonly appRoot: string
  readonly calls: Extract<ClientToolTurn, { mode: "abandon" }>["calls"]
  readonly clientParks: readonly PendingInterrupt[]
  /** The route this request runs; the close may be on another's park. */
  readonly currentRouteKey: string
  /** The same route-execution instances the turn is prepared with. */
  readonly instances: Omit<BootResolvedInstances, "checkpointer" | "threadsStore"> & {
    readonly checkpointer: BaseCheckpointSaver
    readonly sandboxManager?: SandboxManager
    readonly threadId: string
    readonly threadsStore: ThreadsStore
  }
  readonly middlewareContext: Readonly<Record<string, unknown>> | undefined
  readonly registry: RuntimeRegistry
  readonly signal: AbortSignal
  readonly store: ClientToolRuntime["store"]
}): Promise<Response | undefined> {
  const { instances } = options
  const { checkpointer, threadId } = instances
  const parkedIds = clientToolCallIds(options.clientParks)
  const recordedRoutes = new Set(
    ((await options.store?.listForThread(threadId)) ?? [])
      .filter((row) => parkedIds.has(row.toolCallId))
      .map((row) => row.routeId),
  )
  const parkedRouteKey =
    recordedRoutes.size === 0
      ? readParkedRoute(await instances.threadsStore.getThread(threadId))
      : recordedRoutes.size === 1
        ? [...recordedRoutes][0]
        : undefined
  const parkedRoute =
    parkedRouteKey === undefined ? undefined : options.registry.lookup(parkedRouteKey)
  if (parkedRoute?.mode !== "agent") {
    // Fail closed, but loudly: until an operator repairs the thread, every
    // abandon on it is refused here.
    console.warn(
      `B4: cannot close abandoned client tool calls on ${threadId}: ${
        recordedRoutes.size > 1
          ? "the parked calls were issued by different routes"
          : parkedRouteKey === undefined
            ? "the issuing route is not recorded"
            : "the issuing route is not a resolvable agent route"
      }.`,
    )
    return clientToolCloseFailed(
      "The route that parked this thread's client tool calls cannot be resolved; they cannot be closed.",
    )
  }
  try {
    // The request's middleware context was computed for THIS request's
    // route, so it is reused only when that is the route that issued; a
    // cross-route close materializes the parked route without it.
    const sameRoute = parkedRouteKey === options.currentRouteKey
    const graph = (await materializeResolvedRouteGraph({
      appRoot: options.appRoot,
      ...instances,
      clientTools: withParkedClientTools([], options.clientParks),
      ...(sameRoute && options.middlewareContext
        ? { middlewareContext: options.middlewareContext }
        : {}),
      routeFile: parkedRoute.routeFile,
      routeId: parkedRoute.routeId,
      routePath: parkedRoute.routePath,
      signal: options.signal,
    })) as ClosableAgentGraph
    await closeAbandonedClientToolCalls({ graph, checkpointer, threadId, calls: options.calls })
    return undefined
  } catch (error) {
    if (error instanceof ClientToolAbandonError) {
      switch (error.code) {
        case "non_client_park_pending":
          return Response.json(
            createRequestErrorBody(
              "Pending interrupts must be resumed before a parked client tool call can be abandoned",
              { code: "resume_required" },
            ),
            { status: 409 },
          )
        case "no_client_park":
        case "unknown_call":
        case "unclosed_call":
          return clientToolCloseFailed(
            "The thread's parked client tool calls changed; they were not closed.",
          )
        case "close_incomplete":
          // The thread's state may have been written: never retried, and
          // the turn does not run.
          console.error(`B4: closing abandoned client tool calls on ${threadId} was incomplete.`)
          return Response.json(
            createRequestErrorBody(
              "Closing the parked client tool calls did not complete; the thread needs attention.",
              { code: "client_tool_close_incomplete" },
            ),
            { status: 500 },
          )
      }
    }
    console.error(`B4: closing abandoned client tool calls on ${threadId} failed.`, error)
    return Response.json(createRequestErrorBody("Closing the parked client tool calls failed."), {
      status: 500,
    })
  }
}

function clientToolCloseFailed(message: string): Response {
  return Response.json(createRequestErrorBody(message, { code: "client_tool_close_failed" }), {
    status: 409,
  })
}

/** Test seam: the settle-time client record void, exported only for unit tests. */
export const __voidSettledClientToolCallsForTests = voidSettledClientToolCalls

/**
 * Void the thread's outstanding client tool records once a turn settled
 * without parking, keeping any whose park is still pending. Like
 * `voidSupersededGrants`, never allowed to fail the turn.
 */
async function voidSettledClientToolCalls(
  store: NonNullable<ClientToolRuntime["store"]>,
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<void> {
  try {
    const outstanding = await store.listOutstanding(threadId)
    if (outstanding.length === 0) return
    const stillParked = clientToolCallIds(
      (await readPendingInterrupts(checkpointer, threadId))?.interrupts ?? [],
    )
    const toolCallIds = outstanding
      .map((row) => row.toolCallId)
      .filter((toolCallId) => !stillParked.has(toolCallId))
    if (toolCallIds.length === 0) return
    await store.voidOutstanding({ threadId, toolCallIds, at: new Date().toISOString() })
  } catch (error) {
    console.warn(`B4: could not void settled client tool calls for ${threadId}.`, error)
  }
}

function clientToolStoreUnavailable(): Response {
  return Response.json(
    createRequestErrorBody(
      "Client tools are unavailable: no client tool store is configured (server.agui.clientToolStore).",
      { code: "client_tool_store_unavailable" },
    ),
    { status: 503 },
  )
}

/**
 * Screens `role: "tool"` messages over MAX_CLIENT_TOOL_RESULT before
 * `resolveClientToolTurn`, which stores answers before it decides anything,
 * so an over-cap result is never recorded.
 *
 * 413 only when this request is ANSWERING: its last message is a tool message
 * and an over-cap one answers an outstanding, unexpired parked call. Every
 * AG-UI client resends its history, so refusing any other request that still
 * carries an over-cap result would dead-end the thread: every later run,
 * including a new user message after the TTL, would be refused forever.
 * Otherwise the over-cap messages are dropped from what the resolver sees, so
 * the call reads as unanswered and is abandoned with
 * ABANDONED_CLIENT_TOOL_RESULT; the over-cap content never reaches the store
 * or the model.
 */
async function screenOversizedClientToolResults<
  M extends { readonly role: string; readonly content: string; readonly toolCallId?: string },
>(
  store: NonNullable<ClientToolRuntime["store"]>,
  threadId: string,
  clientParks: readonly PendingInterrupt[],
  messages: readonly M[],
  now: Date,
): Promise<{ readonly refused?: Response; readonly messages: readonly M[] }> {
  const encoder = new TextEncoder()
  const oversized = (message: M): boolean =>
    message.role === "tool" && encoder.encode(message.content).byteLength > MAX_CLIENT_TOOL_RESULT
  if (!messages.some(oversized)) return { messages }
  if (messages.at(-1)?.role === "tool") {
    const parked = clientToolCallIds(clientParks)
    const answerable = new Set(
      (await store.listOutstanding(threadId))
        .filter((row) => parked.has(row.toolCallId) && !isClientToolCallExpired(row, now))
        .map((row) => row.toolCallId),
    )
    const refused = messages.some(
      (message) =>
        oversized(message) &&
        typeof message.toolCallId === "string" &&
        answerable.has(message.toolCallId),
    )
    if (refused) {
      return {
        refused: Response.json(
          createRequestErrorBody(`Client tool result exceeds ${MAX_CLIENT_TOOL_RESULT} bytes`, {
            code: "client_tool_result_too_large",
            maxBytes: MAX_CLIENT_TOOL_RESULT,
          }),
          { status: 413 },
        ),
        messages,
      }
    }
  }
  return { messages: messages.filter((message) => !oversized(message)) }
}

/**
 * The request's client tools plus a stub definition for each parked call
 * whose tool the request did not send. The rebuilt definition only has to
 * carry the name: the call is already made, and the stub's replay reads its
 * result from the resume value, not from its schema. It is replay-only, so a
 * NEW call to it is refused instead of parked.
 */
function withParkedClientTools(
  requested: readonly ClientToolDefinition[],
  parks: readonly PendingInterrupt[],
): readonly ClientToolDefinition[] {
  const names = new Set(requested.map((tool) => tool.name))
  const rebuilt: ClientToolDefinition[] = []
  for (const park of parks) {
    if (!isClientToolCallEnvelope(park.value)) continue
    const name = park.value.name
    if (typeof name !== "string" || names.has(name)) continue
    names.add(name)
    // Replay-only: the model may still call the rebuilt stub anew in the
    // resumed turn, and that call must not park on a tool the client did not
    // offer on this run.
    rebuilt.push({
      name,
      description: "",
      parameters: { type: "object", properties: {} },
      replayOnly: true,
    })
  }
  return rebuilt.length === 0 ? requested : [...requested, ...rebuilt]
}

/**
 * The whole AG-UI answer to a run that recorded some parked results but not
 * all: RUN_STARTED, then RUN_FINISHED with a success outcome. The graph is not
 * touched and nothing is published to the live turn — there is no turn.
 */
async function clientToolPartialResponse(
  threadId: string,
  runId: string,
  accept: string | null,
): Promise<Response> {
  async function* done(): AsyncGenerator<B4AgentStreamChunk> {
    yield { type: "done", data: null }
  }
  let body = ""
  for await (const event of toAguiEvents(done(), { threadId, runId })) {
    body += encodeAgUiSse(event, accept ?? undefined)
  }
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    },
    status: 200,
  })
}

/** The SDK-facing view of one inbound message: role, text, and the client's id when it sent one. */
function toAfterMessage(message: {
  readonly role: string
  readonly content: string
  readonly id?: string | undefined
}): MiddlewareAfterMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.id !== undefined ? { id: message.id } : {}),
  }
}

function safeEnqueue(controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) {
  try {
    controller.enqueue(chunk)
  } catch {
    // The consumer already canceled the stream - writes become no-ops, exactly
    // like `response.write` on a disconnected socket did.
  }
}

function safeClose(controller: ReadableStreamDefaultController<Uint8Array>) {
  try {
    controller.close()
  } catch {
    // Already canceled/errored.
  }
}
