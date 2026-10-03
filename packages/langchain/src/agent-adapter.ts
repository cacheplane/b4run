import type { PromptFragment, StreamTransformer } from "@b4run/core"
import { readRuntimeEnv } from "@b4run/core"
import type {
  ApprovalGrantMinter,
  B4Agent,
  B4ContentPart,
  BuiltInModelProviderId,
  ClientToolRecorder,
  RetryConfig,
} from "@b4run/sdk"
import {
  APPROVAL_GRANT_MINTER_KEY,
  CLIENT_TOOL_RECORDER_KEY,
  isB4Agent,
  isContentPart,
} from "@b4run/sdk"
import {
  type BaseMessageLike,
  HumanMessage,
  type MessageContent,
  SystemMessage,
} from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { type CanonicalJsonStream, createCanonicalJsonStream } from "./canonical-json-stream.js"
import {
  createChatModel,
  DEFAULT_MODALITY_SUPPORT,
  type JsonSchemaResponseFormat,
  type ModalitySupport,
  resolveModalitySupport,
} from "./chat-model-factory.js"
import { trackCheckpointWrites } from "./checkpoint-writes.js"
import {
  type ConvertedContent,
  type DroppedPart,
  droppedPartsData,
  formatDroppedPartsWarning,
  pickDroppedPartsReport,
  toLangChainContent,
  V1_RESPONSE_METADATA,
} from "./content-parts.js"
import { readLogicalToolCallId } from "./logical-tool-call-id.js"
import { providerMaxRetries, resolveModelRetryPolicy } from "./model-call-retry.js"
import { resolveProvider } from "./model-provider-resolver.js"
import { withRetry } from "./retry.js"
import { materializeAgentStateSchema, type ResolvedStateField } from "./state-adapter.js"
import { convertSubagentTaskToLangChain, type SubagentResolver } from "./subagent-tool-bridge.js"
import type { ResolvedSummarizationConfig } from "./summarization/index.js"
import { composeSystemPrompt } from "./system-prompt.js"
import { convertToolToLangChain, type OffloadFn } from "./tool-converter.js"

export interface B4ToolDefinition {
  readonly description?: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
      /**
       * The provider's id for this call, stable across LangGraph's re-execution
       * of an interrupted tool node. Absent when the tool is invoked outside a
       * model tool call.
       */
      readonly toolCallId?: string
    },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
  /** End the run on this tool's successful result; see the core `B4ToolDefinition`. */
  readonly returnDirect?: boolean
}

interface AgentLike {
  readonly invoke: (input: unknown, config?: unknown) => Promise<unknown>
}

function assertAgentLike(entry: unknown): asserts entry is AgentLike {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("invoke" in entry) ||
    typeof (entry as { invoke?: unknown }).invoke !== "function"
  ) {
    throw new Error("Agent entry must expose invoke(input) — expected a LangChain agent")
  }
}

/**
 * Compiled-graph cache, keyed by BOTH the agent descriptor and the checkpointer
 * instance the graph was compiled against.
 *
 * `createAgent` EMBEDS the checkpointer in the graph it returns, so a cache
 * keyed on the descriptor alone hands request N+1 a graph wired to request N's
 * checkpointer. On node that is invisible (one boot-resolved checkpointer lives
 * for the process). On an edge runtime it is the whole bug the per-request store
 * seam exists to prevent: Cloudflare workerd binds a Postgres connection to the
 * I/O context of the request that opened it, so request N+1 writing through
 * request N's — by then disposed — pool hangs for ~30s and fails.
 *
 * Keying on the checkpointer makes the cache a function of everything the
 * compile actually closes over, because the checkpointer's identity tracks the
 * identity of the whole per-request store bag: `RequestStores` builds
 * checkpointer, threads, permissions and memory stores together and disposes
 * them together, and the converted tools close over the permissions/memory
 * stores from that same bag. One bag ⇒ one graph; a new bag ⇒ a new graph with
 * freshly bound tools.
 *
 * Both levels are weak, so nothing outlives its owner: the outer entry dies with
 * the descriptor, and the inner entry dies with the request's checkpointer. (V8's
 * WeakMap is ephemeron-based, so the graph→checkpointer reference held by the
 * VALUE does not keep its own KEY alive.)
 */
let materializedAgents = new WeakMap<B4Agent, WeakMap<BaseCheckpointSaver, AgentLike>>()

/**
 * Test-only escape hatch: reset the materialized-agents cache so the next
 * harness run creates a fresh LLM instance (e.g. pointing at a new aimock
 * port). Exported (and re-exported via `@b4run/cli/runtime`) so the
 * `@b4run/testing` harness can clear the cache on teardown. Not for
 * production use; the `__`/`ForTests` name marks it internal-by-convention.
 */
export function __resetMaterializedAgentsForTests(): void {
  materializedAgents = new WeakMap()
}

/** What the materialized agent's root model takes, read once at model construction. */
interface MaterializedModality {
  readonly support: ModalitySupport
  readonly provider: BuiltInModelProviderId | undefined
  readonly model: string | undefined
}

/**
 * Keyed by the materialized agent, so a graph served from `materializedAgents`
 * keeps the modality recorded when it was first built.
 */
const materializedModality = new WeakMap<AgentLike, MaterializedModality>()

/** A raw runnable owns its own model: B4 cannot read it, so assume the conservative default. */
const RAW_RUNNABLE_MODALITY: MaterializedModality = {
  support: DEFAULT_MODALITY_SUPPORT,
  provider: undefined,
  model: undefined,
}

export async function composePromptMessages(
  systemPrompt: string,
  promptFragments: readonly PromptFragment[],
  state: Record<string, unknown>,
): Promise<BaseMessageLike[]> {
  const composed = await composeSystemPrompt(systemPrompt, promptFragments, state)
  const messages = Array.isArray(state.messages) ? (state.messages as BaseMessageLike[]) : []
  return [{ role: "system", content: composed }, ...messages]
}

async function materializeAgent(
  descriptor: B4Agent,
  tools: readonly B4ToolDefinition[],
  checkpointer: BaseCheckpointSaver | undefined,
  opts: {
    readonly stateFields?: readonly ResolvedStateField[]
    readonly middlewareContext?: Readonly<Record<string, unknown>>
    readonly promptFragments?: readonly PromptFragment[]
    readonly bypassCache?: boolean
    readonly offload?: OffloadFn
    readonly summarization?: ResolvedSummarizationConfig
    readonly routeParamNames?: readonly string[]
    readonly streamTransformers?: readonly StreamTransformer[]
    readonly subagentResolver?: SubagentResolver
    readonly responseFormat?: JsonSchemaResponseFormat
  } = {},
): Promise<AgentLike> {
  // Converted tools capture middleware context, including request-specific
  // identity and authorization. Never read or seed the shared cache with it.
  // A response format is per-request too: it is bound INTO the model, so a
  // cached graph would either carry one request's schema into the next or
  // hand a format-bound request the unbound graph.
  const bypassCache =
    opts.middlewareContext !== undefined ||
    opts.subagentResolver !== undefined ||
    opts.bypassCache === true ||
    opts.responseFormat !== undefined ||
    (opts.streamTransformers?.length ?? 0) > 0

  // Without a checkpointer there is no cache key at all (the graph carries no
  // per-request resource either), so those calls simply always compile.
  const cacheKey = bypassCache ? undefined : checkpointer

  if (cacheKey) {
    const cached = materializedAgents.get(descriptor)?.get(cacheKey)
    if (cached) return cached
  }

  const [{ createAgent }, { createB4AgentMiddleware }] = await Promise.all([
    import("langchain"),
    import("./agent-middleware.js"),
  ])

  const provider = resolveProvider({
    model: descriptor.model,
    ...(descriptor.provider !== undefined ? { provider: descriptor.provider } : {}),
  })
  const retry = resolveModelRetryPolicy(descriptor.retry)
  const llm = await createChatModel({
    model: descriptor.model,
    provider,
    maxRetries: providerMaxRetries(retry),
    ...(descriptor.reasoning ? { reasoning: descriptor.reasoning } : {}),
    ...(opts.responseFormat ? { responseFormat: opts.responseFormat } : {}),
  })
  const modality: MaterializedModality = {
    support: resolveModalitySupport(llm, provider),
    provider,
    model: descriptor.model,
  }

  const langchainTools = tools.map((tool) => {
    if (tool.name === "task" && opts.subagentResolver) {
      return convertSubagentTaskToLangChain(tool, opts.subagentResolver)
    }
    const converted = convertToolToLangChain(
      tool,
      opts.middlewareContext,
      opts.offload,
      opts.routeParamNames ?? [],
      opts.streamTransformers ?? [],
      modality,
    )
    // `createAgent` ends the run on a flagged tool's result by name, error or
    // not; B4's loop-entry middleware routes these instead (`endsOnReturnDirect`).
    converted.returnDirect = false
    return converted
  })

  const runningSummaryField: ResolvedStateField = {
    name: "runningSummary",
    reducer: "replace",
    default: undefined,
  }
  const effectiveStateFields: readonly ResolvedStateField[] = opts.summarization
    ? [...(opts.stateFields ?? []).filter((f) => f.name !== "runningSummary"), runningSummaryField]
    : (opts.stateFields ?? [])

  const middleware = createB4AgentMiddleware({
    systemPrompt: descriptor.systemPrompt,
    // Fragments re-render on every model turn so they can reflect live state
    // (e.g., the current todos list).
    promptFragments: opts.promptFragments ?? [],
    stateFieldNames: effectiveStateFields.map((f) => f.name),
    ...(opts.summarization ? { summarization: opts.summarization } : {}),
    returnDirectToolNames: new Set(
      tools.filter((tool) => tool.returnDirect === true).map((tool) => tool.name),
    ),
    retry,
  })

  const agentOptions: Record<string, unknown> = {
    model: llm,
    tools: langchainTools,
    // One graph task per tool call (the default, pinned): parallel calls run,
    // checkpoint and interrupt independently.
    version: "v2",
    // A SystemMessage, not a string: `createAgent` turns a string prompt into
    // a text content block, which changes the provider payload from the plain
    // string system message routes have always sent.
    systemPrompt: new SystemMessage(descriptor.systemPrompt),
    middleware,
    ...(effectiveStateFields.length > 0
      ? { stateSchema: materializeAgentStateSchema(effectiveStateFields) }
      : {}),
    // Tracked so a failed turn can drain the writes it already issued before
    // the failure propagates; see `trackCheckpointWrites`.
    ...(checkpointer ? { checkpointer: trackCheckpointWrites(checkpointer).saver } : {}),
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options don't satisfy createAgent's inferred generics
  const compiled = createAgent(agentOptions as any)
  materializedModality.set(compiled as unknown as AgentLike, modality)

  if (cacheKey) {
    let byCheckpointer = materializedAgents.get(descriptor)
    if (byCheckpointer === undefined) {
      byCheckpointer = new WeakMap()
      materializedAgents.set(descriptor, byCheckpointer)
    }
    byCheckpointer.set(cacheKey, compiled as unknown as AgentLike)
  }
  return compiled as unknown as AgentLike
}

export async function materializeAgentGraph(options: {
  /** Bypass the compiled-graph cache when tools close over invocation-local state. */
  readonly bypassCache?: boolean
  readonly checkpointer?: BaseCheckpointSaver
  readonly descriptor: B4Agent
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly offload?: OffloadFn
  readonly routeParamNames?: readonly string[]
  readonly tools?: readonly B4ToolDefinition[]
  readonly stateFields?: readonly ResolvedStateField[]
  readonly streamTransformers?: readonly StreamTransformer[]
  readonly promptFragments?: readonly PromptFragment[]
  readonly summarization?: ResolvedSummarizationConfig
  /** Bind the root model's final message to a JSON schema; see `createChatModel`. */
  readonly responseFormat?: JsonSchemaResponseFormat
  readonly subagentResolver?: SubagentResolver
  /**
   * Set when the caller's tools are bound to a per-thread sandbox (workspace
   * fs/exec backends). Bypasses the per-descriptor cache so one thread's
   * sandbox closures never leak into another thread's agent.
   */
  readonly sandboxed?: boolean
}): Promise<unknown> {
  return materializeAgent(options.descriptor, options.tools ?? [], options.checkpointer, {
    ...(options.stateFields ? { stateFields: options.stateFields } : {}),
    ...(options.middlewareContext ? { middlewareContext: options.middlewareContext } : {}),
    ...(options.promptFragments ? { promptFragments: options.promptFragments } : {}),
    ...(options.offload ? { offload: options.offload } : {}),
    ...(options.routeParamNames ? { routeParamNames: options.routeParamNames } : {}),
    ...(options.summarization ? { summarization: options.summarization } : {}),
    ...(options.streamTransformers ? { streamTransformers: options.streamTransformers } : {}),
    ...(options.subagentResolver ? { subagentResolver: options.subagentResolver } : {}),
    ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
    ...(options.bypassCache === true || options.sandboxed === true ? { bypassCache: true } : {}),
  })
}

/** An agent event; text tokens may identify their originating model invocation. */
export interface AgentStreamChunk {
  readonly type:
    | "token"
    | "tool_call"
    | "tool_call_args"
    | "tool_result"
    | "interrupt"
    | "done"
    | (string & {})
  readonly data: unknown
  /** Model invocation identity for text tokens, scoped to this stream. */
  readonly messageId?: string
}

interface CapabilityEventPayload {
  readonly data: unknown
  readonly event: string
}

interface LangChainStreamEvent {
  readonly event: string
  readonly run_id: string
  readonly data: Record<string, unknown> & {
    readonly chunk?: unknown
    readonly input?: unknown
    readonly output?: unknown
    readonly error?: unknown
  }
  readonly metadata?: Record<string, unknown>
  readonly name: string
  readonly parent_ids?: string[]
}

interface SubagentContext {
  readonly callId: string
  readonly depth: number
  readonly name: string
  readonly routeId: string
}

interface StreamEventProjection {
  readonly capturesFinalOutput: boolean
  readonly child: SubagentContext | undefined
  readonly chunks: readonly AgentStreamChunk[]
  readonly finalOutput: unknown
  readonly interrupts: readonly RawInterruptEntry[]
}

interface SubagentToolRunContexts {
  readonly contextsByToolRunId: Map<string, SubagentContext | null>
}

/** One owner's (root's, or one subagent's) tool bookkeeping for a stream pass. */
interface ToolProjectionState {
  /** Model invocations with open text or reasoning output, closed by `message_end`. */
  readonly textModelRunIds: Set<string>
  /** Logical/fallback ids whose tool_call chunk was already emitted this stream. */
  readonly announcedToolCallIds: Set<string>
  /** on_tool_start data awaiting resolution at on_tool_end, keyed by execution run id. */
  readonly heldToolStarts: Map<string, { readonly name: string; readonly input: unknown }>
  /**
   * Executions that threw (a non-interrupt `on_tool_error`), awaiting the
   * error ToolMessage LangGraph's ToolNode hands the model. FIFO by tool name.
   */
  readonly pendingToolErrors: Array<{ readonly name: string; readonly input: unknown }>
  /**
   * Argument fragments in flight, keyed by model run id and then by the
   * provider's fragment index. Streamed for display only: the announce at
   * `on_chat_model_end` remains the sole source of a call's identity and of
   * the complete arguments a tool executes with.
   */
  readonly streamingArgs: Map<string, Map<string, ArgumentStreamState>>
}

/**
 * Root and every subagent get the SAME bookkeeping, keyed by the child's
 * `call_id` (root is `undefined`): a child's tool calls are announced from its
 * own model turn under the model's logical id and paired with their results
 * exactly as root's are, so the AG-UI mapper can frame them identically.
 */
interface OwnerToolStates {
  readonly root: ToolProjectionState
  readonly children: Map<string, ToolProjectionState>
}

function newToolProjectionState(): ToolProjectionState {
  return {
    textModelRunIds: new Set(),
    announcedToolCallIds: new Set(),
    heldToolStarts: new Map(),
    pendingToolErrors: [],
    streamingArgs: new Map(),
  }
}

function toolStateFor(
  owners: OwnerToolStates,
  child: SubagentContext | undefined,
): ToolProjectionState {
  if (child === undefined) return owners.root
  let state = owners.children.get(child.callId)
  if (state === undefined) {
    state = newToolProjectionState()
    owners.children.set(child.callId, state)
  }
  return state
}

/**
 * A root-shaped chunk as the child's: the type gains the `subagent.` prefix
 * and the identity joins `data`. A string payload (`token`, `reasoning`)
 * moves under a `data` key beside its `messageId`; an object payload keeps
 * its keys. The identity spreads LAST so it can never be shadowed.
 */
function wrapChild(child: SubagentContext | undefined, chunk: AgentStreamChunk): AgentStreamChunk {
  if (child === undefined) return chunk
  const payload: Record<string, unknown> = isRecord(chunk.data)
    ? { ...chunk.data }
    : {
        data: chunk.data,
        ...(chunk.messageId !== undefined ? { messageId: chunk.messageId } : {}),
      }
  return { type: `subagent.${chunk.type}`, data: { ...payload, ...childIdentity(child) } }
}

interface ArgumentStreamState {
  id: string | undefined
  name: string | undefined
  /** Raw fragments received before the id and name were both known. */
  buffered: string
  readonly stream: CanonicalJsonStream
  /** `silent` once the call is known to be one this stream must not narrate. */
  mode: "pending" | "streaming" | "silent"
}

/** Built-in orchestration tools, whose arguments have no display value. */
const NON_STREAMING_TOOL_NAMES: ReadonlySet<string> = new Set(["writeTodos", "task"])

interface ToolCallFragment {
  readonly id?: unknown
  readonly name?: unknown
  readonly args?: unknown
  readonly index?: unknown
}

/**
 * Project a model chunk's `tool_call_chunks` to `tool_call_args` deltas.
 * Fragments carry `id` and `name` on their first appearance and `index`
 * thereafter, so correlation is by index (falling back to the id). Emission
 * starts once both id and name are known, and never for a call already
 * announced or for an orchestration tool.
 */
function projectToolCallFragments(
  tools: ToolProjectionState,
  runId: string,
  chunk: unknown,
): AgentStreamChunk[] {
  const fragments = (chunk as { tool_call_chunks?: unknown })?.tool_call_chunks
  if (!Array.isArray(fragments) || fragments.length === 0) return []
  let byIndex = tools.streamingArgs.get(runId)
  const out: AgentStreamChunk[] = []
  for (const fragment of fragments as ToolCallFragment[]) {
    if (!isRecord(fragment)) continue
    const id = typeof fragment.id === "string" && fragment.id !== "" ? fragment.id : undefined
    const key =
      typeof fragment.index === "number"
        ? String(fragment.index)
        : id !== undefined
          ? `id:${id}`
          : undefined
    if (key === undefined) continue
    if (byIndex === undefined) {
      byIndex = new Map()
      tools.streamingArgs.set(runId, byIndex)
    }
    let state = byIndex.get(key)
    if (state === undefined) {
      state = {
        id: undefined,
        name: undefined,
        buffered: "",
        stream: createCanonicalJsonStream(),
        mode: "pending",
      }
      byIndex.set(key, state)
    }
    if (state.mode === "silent") continue
    if (id !== undefined) state.id ??= id
    if (typeof fragment.name === "string" && fragment.name !== "") state.name ??= fragment.name
    const args = typeof fragment.args === "string" ? fragment.args : ""
    if (state.mode === "pending") {
      state.buffered += args
      if (state.id === undefined || state.name === undefined) continue
      if (tools.announcedToolCallIds.has(state.id) || NON_STREAMING_TOOL_NAMES.has(state.name)) {
        state.mode = "silent"
        state.buffered = ""
        continue
      }
      state.mode = "streaming"
      const delta = state.stream.push(state.buffered)
      state.buffered = ""
      if (delta.length > 0) {
        out.push({ type: "tool_call_args", data: { id: state.id, name: state.name, delta } })
      }
      continue
    }
    const delta = state.stream.push(args)
    if (delta.length > 0) {
      out.push({ type: "tool_call_args", data: { id: state.id, name: state.name, delta } })
    }
  }
  return out
}

/** End of the model turn: release whatever the transcoders still hold. */
function flushToolCallFragments(tools: ToolProjectionState, runId: string): AgentStreamChunk[] {
  const byIndex = tools.streamingArgs.get(runId)
  if (byIndex === undefined) return []
  tools.streamingArgs.delete(runId)
  const out: AgentStreamChunk[] = []
  for (const state of byIndex.values()) {
    if (state.mode !== "streaming") continue
    const delta = state.stream.flush()
    if (delta.length > 0) {
      out.push({ type: "tool_call_args", data: { id: state.id, name: state.name, delta } })
    }
  }
  return out
}

interface ErrorToolMessageView {
  readonly id: string
  readonly name: string
  readonly message: unknown
}

/**
 * Reads a `status: "error"` ToolMessage in either its live instance shape
 * (`{ status, name, tool_call_id }`) or its serialized shape
 * (`{ id: [..., "ToolMessage"], kwargs: { status, name, tool_call_id } }`).
 * Returns undefined for anything else — including hostile getters.
 */
function readErrorToolMessage(value: unknown): ErrorToolMessageView | undefined {
  try {
    if (!isRecord(value)) return undefined
    const fields = isRecord(value.kwargs) ? value.kwargs : value
    if (fields.status !== "error") return undefined
    const id = fields.tool_call_id
    const name = fields.name
    if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") {
      return undefined
    }
    return { id, name, message: value }
  } catch {
    return undefined
  }
}

function readOutputMessages(output: unknown): readonly unknown[] {
  try {
    if (!isRecord(output)) return []
    if (Array.isArray(output.messages)) return output.messages
    if (isRecord(output.update) && Array.isArray(output.update.messages)) {
      return output.update.messages
    }
    return []
  } catch {
    return []
  }
}

/**
 * Resolves pending root tool errors against a chain output's messages.
 *
 * `on_tool_error` never carries the model/provider tool-call id — only the
 * raw (usually stringified) error — so a thrown tool cannot be resolved at
 * that event. LangGraph's ToolNode catches the throw and appends a
 * `status: "error"` ToolMessage for the model; that message surfaces in the
 * tools node's `on_chain_end` (and, as a fallback for graphs whose tool node
 * we never observe, in the top-level output). Emitting it as the
 * `tool_result` keeps a failing call keyed by the same logical id and
 * serialized exactly like a successful one, instead of leaving the client
 * with a call that never resolves.
 *
 * Matching is by tool name, FIFO, and each pending error resolves at most
 * once. `fromEnd` scans newest-first so a multi-turn final output resolves
 * this turn's error rather than an older message with the same tool name.
 */
function resolveToolErrors(
  tools: ToolProjectionState,
  output: unknown,
  fromEnd: boolean,
): AgentStreamChunk[] {
  if (tools.pendingToolErrors.length === 0) return []
  const messages = readOutputMessages(output)
  const chunks: AgentStreamChunk[] = []
  const ordered = fromEnd ? [...messages].reverse() : messages
  for (const candidate of ordered) {
    if (tools.pendingToolErrors.length === 0) break
    const view = readErrorToolMessage(candidate)
    if (!view) continue
    const index = tools.pendingToolErrors.findIndex((p) => p.name === view.name)
    if (index === -1) continue
    const [pending] = tools.pendingToolErrors.splice(index, 1)
    if (!tools.announcedToolCallIds.has(view.id)) {
      tools.announcedToolCallIds.add(view.id)
      chunks.push({
        type: "tool_call",
        data: { id: view.id, name: view.name, input: pending?.input },
      })
    }
    chunks.push({
      type: "tool_result",
      data: { id: view.id, name: view.name, output: view.message },
    })
  }
  return fromEnd ? chunks.reverse() : chunks
}

interface SubagentPhaseProjection {
  readonly chunk: AgentStreamChunk
  readonly context: SubagentContext
  readonly toolRunId: string | undefined
}

const CAPABILITY_EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/
const RESERVED_ROOT_EVENT_NAMES = new Set([
  "chunk",
  "token",
  "message_end",
  "tool_call",
  "tool_result",
  "interrupt",
  "done",
])

function isCapabilityEventName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CAPABILITY_EVENT_NAME_PATTERN.test(value) &&
    !RESERVED_ROOT_EVENT_NAMES.has(value) &&
    !value.startsWith("subagent.")
  )
}

function parseCapabilityEvent(value: unknown): CapabilityEventPayload | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const payload = value as Record<string, unknown>
  if (!Object.hasOwn(payload, "event")) return undefined
  if (!isCapabilityEventName(payload.event)) return undefined
  if (!Object.hasOwn(payload, "data")) return undefined
  return { event: payload.event, data: payload.data }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseSubagentContext(
  metadata: Record<string, unknown> | undefined,
): SubagentContext | undefined {
  const b4 = metadata?.b4
  if (!isRecord(b4)) return undefined
  const stack = b4.subagent_stack
  if (!Array.isArray(stack) || stack.length === 0) return undefined

  for (const value of stack) {
    if (!isRecord(value)) return undefined
    if (typeof value.callId !== "string" || value.callId === "") return undefined
    if (typeof value.name !== "string" || value.name === "") return undefined
    if (typeof value.routeId !== "string" || value.routeId === "") return undefined
  }

  const top = stack.at(-1) as Record<string, unknown>
  return {
    callId: top.callId as string,
    depth: stack.length,
    name: top.name as string,
    routeId: top.routeId as string,
  }
}

function sameSubagentContext(left: SubagentContext, right: SubagentContext): boolean {
  return (
    left.callId === right.callId &&
    left.depth === right.depth &&
    left.name === right.name &&
    left.routeId === right.routeId
  )
}

function indexSubagentContext(
  toolRuns: SubagentToolRunContexts,
  toolRunId: string,
  context: SubagentContext,
): void {
  const existing = toolRuns.contextsByToolRunId.get(toolRunId)
  if (existing === undefined) {
    toolRuns.contextsByToolRunId.set(toolRunId, context)
  } else if (existing !== null && !sameSubagentContext(existing, context)) {
    toolRuns.contextsByToolRunId.set(toolRunId, null)
  }
}

function resolveEventSubagentContext(
  event: LangChainStreamEvent,
  toolRuns: SubagentToolRunContexts,
): SubagentContext | undefined {
  const direct = parseSubagentContext(event.metadata)
  if (direct) return direct
  if (event.event !== "on_tool_error") return undefined
  return toolRuns.contextsByToolRunId.get(event.run_id) ?? undefined
}

function childIdentity(child: SubagentContext): Record<string, unknown> {
  return {
    call_id: child.callId,
    subagent: child.name,
    route_id: child.routeId,
    depth: child.depth,
  }
}

function childData(child: SubagentContext, data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return { value: data, ...childIdentity(child) }
  // A child capability event of ANY type — not just plan_update, whatever
  // third-party capability produced it — can carry the CHILD's own
  // tool-call id (e.g. a subagent's writeTodos). Only ROOT orchestration
  // correlates a tool call with its activity, and the subagent activity
  // boundary keeps child tool ids internal, so the id is unconditionally
  // dropped here rather than namespaced outward.
  const { tool_call_id: _toolCallId, ...publicData } = data
  return { ...publicData, ...childIdentity(child) }
}

function parseSubagentPhaseEvent(event: LangChainStreamEvent): SubagentPhaseProjection | undefined {
  if (event.event !== "on_custom_event" || event.name !== "b4.subagent") return undefined
  if (!isRecord(event.data)) return undefined
  const phase = event.data.phase
  if (phase !== "start" && phase !== "end") return undefined
  if (typeof event.data.call_id !== "string" || event.data.call_id === "") return undefined
  if (typeof event.data.subagent !== "string" || event.data.subagent === "") return undefined
  if (typeof event.data.route_id !== "string" || event.data.route_id === "") return undefined
  if (
    typeof event.data.depth !== "number" ||
    !Number.isInteger(event.data.depth) ||
    event.data.depth < 1
  ) {
    return undefined
  }

  const context: SubagentContext = {
    callId: event.data.call_id,
    depth: event.data.depth,
    name: event.data.subagent,
    routeId: event.data.route_id,
  }
  const toolRunId =
    typeof event.data.tool_run_id === "string" && event.data.tool_run_id !== ""
      ? event.data.tool_run_id
      : undefined
  const { phase: _phase, tool_run_id: _toolRunId, ...data } = event.data
  return {
    chunk: { type: `subagent.${phase}`, data },
    context,
    toolRunId,
  }
}

/**
 * The text a model chunk carries. Providers stream it either as a plain
 * string or, once tools are bound (Anthropic always, OpenAI's Responses API),
 * as an array of content blocks; only `text` blocks are assistant prose, so
 * thinking, citations and tool-input deltas contribute nothing.
 */
function chunkText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      text += block.text
    }
  }
  return text
}

/**
 * The `usage` chunk for one finished model call, or `undefined` when the
 * provider reported nothing. Labels come from LangChain's standard run
 * metadata (`ls_provider` is the chat-model class name minus `Chat`, so it is
 * lower-cased to match B4.run's provider ids); the counts travel as the
 * provider's own `usage_metadata`, untouched — the AG-UI mapper applies the
 * protocol's accounting rules, and other transports pass the chunk through.
 */
function readUsageChunk(event: LangChainStreamEvent): Record<string, unknown> | undefined {
  const output = event.data.output
  if (!isRecord(output) || !isRecord(output.usage_metadata)) return undefined
  const provider = event.metadata?.ls_provider
  const model = event.metadata?.ls_model_name
  return {
    ...(typeof provider === "string" && provider !== ""
      ? { provider: provider.toLowerCase() }
      : {}),
    ...(typeof model === "string" && model !== "" ? { model } : {}),
    usage_metadata: output.usage_metadata,
  }
}

/**
 * The reasoning text a model chunk carries: Anthropic streams `thinking`
 * blocks (field `thinking`; a `signature_delta` arrives as a thinking block
 * with no text), while the OpenAI Responses converter and LangChain's standard
 * content emit `reasoning` blocks (field `reasoning`; the converter has
 * already flattened a Responses summary into it). `redacted_thinking` and
 * encrypted material are not text and contribute nothing.
 */
function chunkReasoning(content: unknown): string {
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === "thinking" && typeof block.thinking === "string") text += block.thinking
    else if (block.type === "reasoning" && typeof block.reasoning === "string")
      text += block.reasoning
  }
  return text
}

function classifyStreamEvent(
  event: LangChainStreamEvent,
  toolRuns: SubagentToolRunContexts,
  owners: OwnerToolStates,
): StreamEventProjection {
  const phase = parseSubagentPhaseEvent(event)
  if (phase) {
    if (phase.toolRunId !== undefined) {
      indexSubagentContext(toolRuns, phase.toolRunId, phase.context)
    }
    return {
      capturesFinalOutput: false,
      child: phase.context,
      chunks: [phase.chunk],
      finalOutput: undefined,
      interrupts: [],
    }
  }
  const child = resolveEventSubagentContext(event, toolRuns)
  // Every owner takes the same code paths below; a child's chunks leave
  // through `wrap`, as `subagent.<type>` with the identity in `data`.
  const tools = toolStateFor(owners, child)
  const wrap = (chunks: readonly AgentStreamChunk[]): AgentStreamChunk[] =>
    chunks.map((chunk) => wrapChild(child, chunk))

  switch (event.event) {
    case "on_chat_model_stream": {
      const streamed = (event.data.chunk as { content?: unknown })?.content
      const content = chunkText(streamed)
      const reasoning = chunkReasoning(streamed)
      const chunks: AgentStreamChunk[] = []
      if (reasoning.length > 0) {
        // Registered like text so this invocation's `on_chat_model_end` emits
        // `message_end`, which is what closes the AG-UI reasoning span.
        tools.textModelRunIds.add(event.run_id)
        chunks.push({ type: "reasoning", data: reasoning, messageId: event.run_id })
      }
      if (content.length > 0) {
        tools.textModelRunIds.add(event.run_id)
        chunks.push({ type: "token", data: content, messageId: event.run_id })
      }
      chunks.push(...projectToolCallFragments(tools, event.run_id, event.data.chunk))
      if (chunks.length === 0) break
      return {
        capturesFinalOutput: false,
        child,
        chunks: wrap(chunks),
        finalOutput: undefined,
        interrupts: [],
      }
    }
    /**
     * Root tool calls are announced here, from the model turn, rather than
     * from `on_tool_start`'s execution run id. LangGraph re-executes an
     * interrupted tool node from scratch on resume — the ToolNode callback
     * gets a FRESH `run_id` each pass — but the checkpointed `AIMessage`
     * keeps the SAME model/provider tool-call id across that whole
     * interrupt→resume cycle. Announcing under that stable id lets an AG-UI
     * client dedupe the pre-interrupt and post-resume streams into one card
     * instead of rendering a duplicate. Execution run ids stay purely
     * internal bookkeeping (see `heldToolStarts` below) and never reach
     * the wire as an identity by themselves when a logical id is available.
     */
    case "on_chat_model_end": {
      const usage = readUsageChunk(event)
      const output = event.data.output as { tool_calls?: unknown } | undefined
      const calls = Array.isArray(output?.tool_calls) ? output.tool_calls : []
      const chunks: AgentStreamChunk[] = flushToolCallFragments(tools, event.run_id)
      if (usage !== undefined) chunks.push({ type: "usage", data: usage })
      if (tools.textModelRunIds.delete(event.run_id)) {
        chunks.push({ type: "message_end", data: { messageId: event.run_id } })
      }
      for (const call of calls) {
        if (!isRecord(call)) continue
        const id = typeof call.id === "string" && call.id !== "" ? call.id : undefined
        const name = typeof call.name === "string" && call.name !== "" ? call.name : undefined
        if (id === undefined || name === undefined) continue
        if (tools.announcedToolCallIds.has(id)) continue
        tools.announcedToolCallIds.add(id)
        chunks.push({ type: "tool_call", data: { id, name, input: call.args } })
      }
      if (chunks.length === 0) break
      return {
        capturesFinalOutput: false,
        child,
        chunks: wrap(chunks),
        finalOutput: undefined,
        interrupts: [],
      }
    }
    case "on_tool_start":
      tools.heldToolStarts.set(event.run_id, {
        name: event.name,
        input: event.data.input ?? event.data.chunk ?? event.data.output,
      })
      break
    case "on_tool_end": {
      /**
       * Three-way resolution for the root announce/result pairing:
       *
       *  (a) The call was already announced from `on_chat_model_end` (its id
       *      is in `announcedToolCallIds`) — this event only ever needs to
       *      emit the matching `tool_result`, keyed by that same id.
       *  (b) The call was never announced from a model turn at all. This is
       *      the resume-replay path: LangGraph re-executes an interrupted
       *      tool node with NO new model turn, so `on_chat_model_end` never
       *      fires for it — the only signals we get are this `on_tool_end`
       *      (plus, usually, a held `on_tool_start`). We announce here,
       *      preferring the logical id recovered from the output and
       *      falling back to the held start's input for `data.input`; when
       *      the provider/output carries no logical id either (e.g. a tool
       *      returning a bare string), we fall back further to the
       *      execution `run_id` itself so ID-less providers still get a
       *      paired announce+result.
       *  (c) An orphan result — no held `on_tool_start` AND no logical id —
       *      means the stream began observation mid-execution (or the tool
       *      genuinely returned nothing identifiable). There is nothing to
       *      announce, so this stays result-only, matching the pre-rekey
       *      behavior for that case exactly.
       */
      const held = tools.heldToolStarts.get(event.run_id)
      tools.heldToolStarts.delete(event.run_id)
      const logicalId = readLogicalToolCallId(event.data.output)
      const id = logicalId ?? event.run_id
      const chunks: AgentStreamChunk[] = []
      if (!tools.announcedToolCallIds.has(id) && (held !== undefined || logicalId !== undefined)) {
        tools.announcedToolCallIds.add(id)
        chunks.push({ type: "tool_call", data: { id, name: event.name, input: held?.input } })
      }
      chunks.push({
        type: "tool_result",
        data: { id, name: event.name, output: event.data.output },
      })
      return {
        capturesFinalOutput: false,
        child,
        chunks: wrap(chunks),
        finalOutput: undefined,
        interrupts: [],
      }
    }
    case "on_custom_event": {
      if (event.name !== "b4.capability") break
      const payload = parseCapabilityEvent(event.data)
      if (!payload) break
      return {
        capturesFinalOutput: false,
        child,
        chunks: [
          child
            ? { type: `subagent.${payload.event}`, data: childData(child, payload.data) }
            : { type: payload.event, data: payload.data },
        ],
        finalOutput: undefined,
        interrupts: [],
      }
    }
    case "on_chain_stream":
      return {
        capturesFinalOutput: false,
        child,
        chunks: [],
        finalOutput: undefined,
        interrupts: extractInterrupts(event.data.chunk) ?? [],
      }
    case "on_tool_error": {
      const interrupts = extractInterruptsFromError(event.data.error)
      const held = tools.heldToolStarts.get(event.run_id)
      tools.heldToolStarts.delete(event.run_id)
      // A genuine throw (not an `interrupt()`) resolves later, from the
      // error ToolMessage the tool node appends; see resolveToolErrors.
      if (interrupts === undefined) {
        tools.pendingToolErrors.push({
          name: event.name,
          input: held?.input ?? event.data.input,
        })
      }
      return {
        capturesFinalOutput: false,
        child,
        chunks: [],
        finalOutput: undefined,
        interrupts: interrupts ?? [],
      }
    }
    case "on_chain_end":
      if (!child && event.name === "LangGraph") {
        return {
          capturesFinalOutput: true,
          child,
          chunks: resolveToolErrors(tools, event.data.output, true),
          finalOutput: event.data.output,
          interrupts: extractInterrupts(event.data.output) ?? [],
        }
      }
      if (child) {
        return {
          capturesFinalOutput: false,
          child,
          // The child's own tools node (and its graph end) resolve the child's
          // thrown tools, exactly as root's do.
          chunks: wrap(resolveToolErrors(tools, event.data.output, event.name === "LangGraph")),
          finalOutput: undefined,
          interrupts: extractInterrupts(event.data.output) ?? [],
        }
      }
      return {
        capturesFinalOutput: false,
        child,
        chunks: resolveToolErrors(tools, event.data.output, false),
        finalOutput: undefined,
        interrupts: [],
      }
  }

  return {
    capturesFinalOutput: false,
    child,
    chunks: [],
    finalOutput: undefined,
    interrupts: [],
  }
}

/**
 * LangGraph 1.x's `interrupt()` throws a `GraphInterrupt` from inside the tool
 * node. Under `streamEvents` v2 this surfaces as an `on_tool_error` whose
 * `event.data.error` is the `GraphInterrupt` instance — its `.name` is
 * `"GraphInterrupt"` and its `.interrupts` array carries the `{ id, value }`
 * entries we need. The top-level `on_chain_end` for `LangGraph` does NOT
 * include `__interrupt__` in this code path (that key appears only on the
 * `invoke`/`stream` return value), so detection must happen at the tool error.
 *
 * We still keep the `__interrupt__` extractor for `on_chain_end` as a
 * defensive fallback in case a future LangGraph version surfaces interrupts
 * via the chain output too.
 */
const INTERRUPT_KEY = "__interrupt__"

interface RawInterruptEntry {
  readonly value?: unknown
  readonly id?: string
  readonly when?: string
  readonly resumable?: boolean
}

function extractInterrupts(output: unknown): readonly RawInterruptEntry[] | undefined {
  if (!output || typeof output !== "object") return undefined
  const maybe = (output as Record<string, unknown>)[INTERRUPT_KEY]
  if (!Array.isArray(maybe)) return undefined
  return maybe as readonly RawInterruptEntry[]
}

const CHILD_INTERRUPT_KINDS = new Set(["command", "memory", "path", "tool"])

function projectInterruptValue(
  entry: RawInterruptEntry,
  child: SubagentContext | undefined,
): unknown {
  const value = entry.value
  if (!child || !isRecord(value) || Object.hasOwn(value, "callId")) return value
  if (!CHILD_INTERRUPT_KINDS.has(String(value.kind))) return value
  return { ...value, callId: child.callId }
}

/**
 * Detects a thrown `GraphInterrupt` surfaced via `on_tool_error`.
 *
 * LangGraph's `interrupt()` throws a `GraphInterrupt` whose `.message` is
 * `JSON.stringify(interrupts)` and whose `.interrupts` array carries the
 * `{ id, value }` entries. By the time the error reaches `streamEvents`'
 * `data.error` it has already been stringified — typically into
 * `<JSON interrupts>\n\nGraphInterrupt: <JSON interrupts>\n    at ...stack`.
 *
 * We handle three shapes defensively:
 *   - object with `.name === "GraphInterrupt"` and `.interrupts` array
 *     (in case a future LangGraph version surfaces the live error)
 *   - object/Error whose stringified message starts with a JSON array
 *   - bare string with the `GraphInterrupt:` marker
 */
function extractInterruptsFromError(error: unknown): readonly RawInterruptEntry[] | undefined {
  if (!error) return undefined

  if (typeof error === "object") {
    const e = error as { name?: unknown; interrupts?: unknown; message?: unknown }
    if (e.name === "GraphInterrupt" && Array.isArray(e.interrupts) && e.interrupts.length > 0) {
      return e.interrupts as readonly RawInterruptEntry[]
    }
    if (typeof e.message === "string") {
      const parsed = parseInterruptStringMessage(e.message)
      if (parsed) return parsed
    }
  }

  if (typeof error === "string") {
    const parsed = parseInterruptStringMessage(error)
    if (parsed) return parsed
  }

  return undefined
}

/**
 * Parses the stringified form of a GraphInterrupt's message. The string
 * begins with `JSON.stringify(interrupts, null, 2)` and is followed by
 * `\n\nGraphInterrupt: ...\n    at ...` stack metadata. We slice the leading
 * JSON array up to the first `]` followed by a newline + non-JSON sentinel
 * and parse it.
 */
function parseInterruptStringMessage(text: string): readonly RawInterruptEntry[] | undefined {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("[")) return undefined
  // Find the matching closing bracket by bracket counting at depth 0 — robust
  // against nested arrays in the interrupt payloads.
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "[") depth++
    else if (ch === "]") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return undefined
  const json = trimmed.slice(0, end + 1)
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined
    return parsed as readonly RawInterruptEntry[]
  } catch {
    return undefined
  }
}

export interface AgentOptions {
  /** Bypass the compiled-graph cache when tools close over invocation-local state. */
  readonly bypassCache?: boolean
  /**
   * Checkpointer used by LangGraph to park interrupted graph state and replay
   * from it on resume. Required — the CLI runtime supplies a SQLite-backed
   * instance by default. If you call agent-adapter directly (e.g. in tests),
   * pass `new MemorySaver()` from `@langchain/langgraph`.
   */
  readonly checkpointer: BaseCheckpointSaver
  readonly entry: unknown
  /**
   * The agent input. For a normal invocation, this is a record like
   * `{messages: [...]}`. For a resume invocation (after a parked interrupt),
   * pass a `Command({resume: decision})` instance directly — the adapter will
   * forward it verbatim to `streamEvents` instead of wrapping it in messages.
   */
  readonly input: unknown
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly offload?: OffloadFn
  /**
   * Run-level retry for a legacy raw runnable that has no `streamEvents`: the
   * `withRetry` fallback re-invokes the whole runnable. Nothing else reads
   * it. An `agent()` descriptor route ignores this field and takes its retry
   * from the descriptor's own `retry`, applied per model call (see
   * `model-call-retry`); a raw runnable that streams is never retried.
   */
  readonly retry?: RetryConfig
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly stateFields?: readonly ResolvedStateField[]
  readonly tools: readonly B4ToolDefinition[]
  readonly promptFragments?: readonly PromptFragment[]
  readonly streamTransformers?: readonly StreamTransformer[]
  /** Resolves guarded task requests to lazily materialized child graphs. */
  readonly subagentResolver?: SubagentResolver
  /**
   * Stable per-conversation identifier used as LangGraph's `thread_id`. When
   * set, the agent-adapter wires it into `config.configurable.thread_id` so
   * the checkpointer can park interrupted state. Required for resume to work
   * — without a thread_id, an interrupt ends the stream with no way to
   * replay.
   */
  readonly threadId?: string
  /**
   * Per-run approval-grant minter, forwarded into
   * `config.configurable[APPROVAL_GRANT_MINTER_KEY]` so the park site in
   * `@b4run/core` can read it from the ambient run config with `getConfig()`.
   *
   * Same channel and same optionality as `threadId`: an invoker that omits it
   * is a legacy invoker, and the park site — not this adapter — decides
   * whether that absence is tolerable. Do NOT default it to a no-op minter
   * here; a silent no-op is exactly the failure the fail-closed rule exists to
   * prevent.
   */
  readonly approvalGrantMinter?: ApprovalGrantMinter
  /**
   * Per-run client tool recorder, forwarded into
   * `config.configurable[CLIENT_TOOL_RECORDER_KEY]` so a client tool stub in
   * `@b4run/core` can record the call it parks. Same channel and optionality
   * as the minter: the stub refuses to park without one, so do NOT default it.
   */
  readonly clientToolRecorder?: ClientToolRecorder
  readonly summarization?: ResolvedSummarizationConfig
  /**
   * A JSON schema the ROOT model's final message must match, bound as the
   * provider's native schema-constrained output alongside the route's tools
   * (see `createChatModel`). Per request, so it forces a fresh graph compile.
   * Unsupported providers throw before any model call.
   */
  readonly responseFormat?: JsonSchemaResponseFormat
  /**
   * Set by the CLI runtime when a per-thread sandbox is active for this turn
   * (the workspace tools close over the thread's sandbox filesystem/exec
   * backend). Forces `bypassCache` in materializeAgent so a cached agent
   * compiled with one thread's sandbox tools is never reused for another
   * thread — the one leak a sandbox must never allow.
   */
  readonly sandboxed?: boolean
}

/** The settled shape of one non-streaming agent turn. */
export interface AgentTurnResult {
  /** Payload of the turn's `done` chunk — the graph's final state. */
  readonly output: unknown
  /**
   * True when the turn PARKED on a HITL interrupt instead of completing. A
   * parked turn ran no further model work: the human's decision arrives on a
   * later resume invocation, which settles the run.
   */
  readonly parked: boolean
}

/**
 * Run an agent turn to settlement and report BOTH its final output and whether
 * it parked.
 *
 * `streamAgent` yields `done` unconditionally at the end of its event stream —
 * including for a parked turn — so `done` alone is not completion. On this
 * path a pending interrupt surfaces ONLY as an `interrupt` chunk: LangGraph's
 * `streamEvents` final output carries no `__interrupt__` key (that key appears
 * only on the `invoke`/`stream` return value), so a caller that keeps just the
 * `done` payload cannot tell a parked turn from a finished one. Callers that
 * must distinguish them — the episode recorder, thread status — use this
 * instead of `executeAgent`.
 */
export async function executeAgentTurn(options: AgentOptions): Promise<AgentTurnResult> {
  let output: unknown
  let parked = false
  for await (const chunk of streamAgent(options)) {
    if (chunk.type === "done") output = chunk.data
    else if (chunk.type === "interrupt") parked = true
    // No stream to announce on: the spec's developer warning is the only signal.
    // (The streaming path logs from the CLI's chunk switch, never reached here.)
    // A subagent's drop rides on `subagent.content_parts_dropped` beside the
    // child's identity fields; the shared picker takes only the report.
    else if (
      chunk.type === "content_parts_dropped" ||
      chunk.type === "subagent.content_parts_dropped"
    ) {
      const report = pickDroppedPartsReport(chunk.data)
      if (report) console.warn(formatDroppedPartsWarning(report))
    }
  }
  return { output, parked }
}

export async function executeAgent(options: AgentOptions): Promise<unknown> {
  return (await executeAgentTurn(options)).output
}

export async function* streamAgent(options: AgentOptions): AsyncGenerator<AgentStreamChunk> {
  if (!options.checkpointer) {
    throw new Error(
      "[b4] agent-adapter requires a checkpointer in AgentOptions. The CLI runtime instantiates sqliteCheckpointer by default; if you're calling agent-adapter directly, pass one explicitly.",
    )
  }

  // If the caller is passing a Command directly (resume path), forward it
  // verbatim without the usual input preparation and message extraction.
  const isCommandInput = options.input instanceof Command
  const { agentInput, config } = prepareAgentCall(options)

  const resolver = options.subagentResolver
  const hasTaskTool = options.tools.some((t) => t.name === "task")

  // B4Agent descriptor path — materialize on first use
  if (isB4Agent(options.entry)) {
    // Resolver and sandbox-backed tools close over route-preparation state, so
    // they must not be reused from another materialized route invocation.
    const materializedAgent = await materializeAgent(
      options.entry,
      options.tools,
      options.checkpointer,
      {
        ...(options.stateFields ? { stateFields: options.stateFields } : {}),
        ...(options.middlewareContext ? { middlewareContext: options.middlewareContext } : {}),
        ...(options.promptFragments ? { promptFragments: options.promptFragments } : {}),
        ...((resolver && hasTaskTool) || options.bypassCache || options.sandboxed
          ? { bypassCache: true }
          : {}),
        ...(options.offload ? { offload: options.offload } : {}),
        ...(options.summarization ? { summarization: options.summarization } : {}),
        routeParamNames: options.routeParamNames,
        ...(options.streamTransformers ? { streamTransformers: options.streamTransformers } : {}),
        ...(resolver ? { subagentResolver: resolver } : {}),
        ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
      },
    )
    const modality = materializedModality.get(materializedAgent) ?? RAW_RUNNABLE_MODALITY
    const extracted = isCommandInput ? NO_EXTRACTED_MESSAGES : extractMessages(agentInput, modality)
    // Announced before the model turn: the run continues without the dropped parts.
    if (extracted.dropped.length > 0) yield droppedPartsChunk(modality, extracted.dropped)
    // `retry` is applied per model call inside the graph (the model's
    // `maxRetries` and B4's capacity-429 middleware), never to the whole run.
    const runnableInput = isCommandInput ? options.input : { messages: extracted.messages }
    const checkpointWrites = trackCheckpointWrites(options.checkpointer)
    yield* streamFromRunnable(materializedAgent, runnableInput, config, undefined, () =>
      checkpointWrites.settled(),
    )
    return
  }

  // Legacy path — raw Runnable with .invoke()
  assertAgentLike(options.entry)
  if (options.responseFormat) {
    throw new Error(
      "A response format can only be bound on an agent() descriptor route: a raw LangChain runnable owns its own model.",
    )
  }

  const langchainTools = options.tools.map((tool) =>
    tool.name === "task" && resolver
      ? convertSubagentTaskToLangChain(tool, resolver)
      : convertToolToLangChain(
          tool,
          options.middlewareContext,
          options.offload,
          options.routeParamNames,
          options.streamTransformers ?? [],
          RAW_RUNNABLE_MODALITY,
        ),
  )
  if (langchainTools.length > 0) {
    config.tools = langchainTools
  }

  const extracted = isCommandInput
    ? NO_EXTRACTED_MESSAGES
    : extractMessages(agentInput, RAW_RUNNABLE_MODALITY)
  if (extracted.dropped.length > 0) {
    yield droppedPartsChunk(RAW_RUNNABLE_MODALITY, extracted.dropped)
  }
  const runnableInput = isCommandInput ? options.input : { messages: extracted.messages }
  yield* streamFromRunnable(options.entry, runnableInput, config, options.retry)
}

function prepareAgentCall(options: AgentOptions): {
  agentInput: Record<string, unknown>
  config: Record<string, unknown>
} {
  const inputRecord = (options.input ?? {}) as Record<string, unknown>
  const params: Record<string, unknown> = {}
  const agentInput: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(inputRecord)) {
    if (options.routeParamNames.includes(key)) {
      params[key] = value
    } else {
      agentInput[key] = value
    }
  }

  const config: Record<string, unknown> = {
    signal: options.signal,
  }
  // Per-agent super-step ceiling. LangGraph's Pregel reads config.recursionLimit
  // (default 25); deep agents (coordinator + subagents + many tool calls) can
  // legitimately need more. Sourced from the B4Agent descriptor, mirroring retry.
  if (isB4Agent(options.entry) && typeof options.entry.recursionLimit === "number") {
    config.recursionLimit = options.entry.recursionLimit
  }

  const configurable: Record<string, unknown> = { ...params }
  if (options.threadId !== undefined && options.threadId.length > 0) {
    configurable.thread_id = options.threadId
  }
  // Spread AFTER `params` so a route param can never shadow the minter: the
  // params come from the URL, this does not.
  if (options.approvalGrantMinter !== undefined) {
    configurable[APPROVAL_GRANT_MINTER_KEY] = options.approvalGrantMinter
  }
  // Likewise after `params`: the recorder is how a parked client tool call is
  // later recognized as answerable, so a URL param must never stand in for it.
  if (options.clientToolRecorder !== undefined) {
    configurable[CLIENT_TOOL_RECORDER_KEY] = options.clientToolRecorder
  }
  if (Object.keys(configurable).length > 0) {
    config.configurable = configurable
  }

  return { agentInput, config }
}

async function* streamFromRunnable(
  runnable: AgentLike,
  input: unknown,
  config: Record<string, unknown>,
  retryConfig?: RetryConfig,
  /** Awaited before a failure propagates, so the turn has stopped writing. */
  drainWrites?: () => Promise<void>,
): AsyncGenerator<AgentStreamChunk> {
  const streamable = runnable as AgentLike & {
    streamEvents?: (
      input: unknown,
      options: Record<string, unknown>,
    ) => AsyncIterable<LangChainStreamEvent>
  }

  if (typeof streamable.streamEvents !== "function") {
    // Fallback: invoke with retry and emit a single done event
    const signal = config.signal as AbortSignal | undefined
    const retryOptions: import("./retry.js").RetryOptions = {
      ...(retryConfig?.maxAttempts ? { maxAttempts: retryConfig.maxAttempts } : {}),
      ...(retryConfig?.baseDelay ? { baseDelayMs: retryConfig.baseDelay } : {}),
      ...(signal ? { signal } : {}),
    }
    const result = await withRetry(
      () => runnable.invoke(input, config),
      Object.keys(retryOptions).length > 0 ? retryOptions : undefined,
    )
    yield { type: "done", data: result }
    return
  }

  // Capture into a typed const so TS narrowing survives across the nested
  // async-generator closure below. Bind to `streamable` — LangGraph's
  // Pregel.streamEvents reads `this.config?.recursionLimit`, so calling it
  // unbound throws "Cannot read properties of undefined (reading 'config')".
  const streamEventsFn = streamable.streamEvents.bind(streamable)

  interface PassResult {
    readonly finalOutput: unknown
    readonly interrupts: readonly RawInterruptEntry[]
  }

  // Process a single streamEvents iterator: yield AgentStreamChunks and
  // return whatever __interrupt__ entries appeared in the graph's final
  // on_chain_end output. A failure ends the run: the run is never started
  // again, because retry belongs to each model call (see `model-call-retry`),
  // and a restarted run would re-run tools and re-stream output.
  async function* processEventStream(
    invocationInput: unknown,
    invocationConfig: Record<string, unknown>,
  ): AsyncGenerator<AgentStreamChunk, PassResult, void> {
    let finalOutput: unknown
    let capturedInterrupts: readonly RawInterruptEntry[] = []
    const emittedInterruptIds = new Set<string>()
    const subagentToolRuns: SubagentToolRunContexts = { contextsByToolRunId: new Map() }
    const owners: OwnerToolStates = { root: newToolProjectionState(), children: new Map() }

    try {
      for await (const event of streamEventsFn(invocationInput, {
        ...invocationConfig,
        version: "v2",
      })) {
        const projection = classifyStreamEvent(event, subagentToolRuns, owners)
        if (projection.capturesFinalOutput) {
          finalOutput = projection.finalOutput
        }
        for (const chunk of projection.chunks) {
          yield chunk
        }
        if (projection.interrupts.length > 0) {
          capturedInterrupts = projection.interrupts
        }
        for (const entry of projection.interrupts) {
          if (entry.id && emittedInterruptIds.has(entry.id)) continue
          if (entry.id) emittedInterruptIds.add(entry.id)
          if (readRuntimeEnv("B4_DEBUG_INTERRUPTS") === "1") {
            if (!isRecord(entry.value) || typeof entry.value.interruptId !== "string") {
              console.warn(
                "[b4] interrupt entry.value missing interruptId — capability bug:",
                JSON.stringify(entry).slice(0, 300),
              )
            }
          }
          yield {
            type: "interrupt",
            data: projectInterruptValue(entry, projection.child),
          }
        }
      }
      return { finalOutput, interrupts: capturedInterrupts }
    } catch (error) {
      // Not on cancellation: a cancelled turn's settle already waits for
      // the abandoned route to unwind, and the writes chained behind a
      // still-running tool would hold the turn open until it finishes.
      if (!(invocationConfig.signal as AbortSignal | undefined)?.aborted) {
        await drainWrites?.()
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  // Invoke the stream. After yielding any interrupt envelopes, return cleanly.
  // Resume is state-based: the caller posts to /threads/:id/resume with the
  // decision, which opens a new SSE stream with Command({resume: decision}) as
  // input. The adapter does NOT park here waiting for an in-process promise.
  const pass = yield* processEventStream(input, config)

  yield { type: "done", data: pass.finalOutput }
}

interface InputMessage {
  readonly role: string
  /** A string, or a part list whose entries may still be malformed (checked per entry). */
  readonly content: string | readonly unknown[]
}

function isInputMessageArray(value: unknown): value is readonly InputMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { role?: unknown }).role === "string" &&
        (typeof (item as { content?: unknown }).content === "string" ||
          Array.isArray((item as { content?: unknown }).content)),
    )
  )
}

interface ExtractedMessages {
  readonly messages: readonly HumanMessage[]
  readonly dropped: readonly DroppedPart[]
}

const NO_EXTRACTED_MESSAGES: ExtractedMessages = { messages: [], dropped: [] }

/**
 * The user turn(s) for the model. Content parts become LangChain standard
 * blocks under what the root model takes; what it cannot take is dropped and
 * returned for the caller to announce — never a failed run (AG-UI 1.0).
 *
 * Blocks go in as `content:` with `response_metadata.output_version: "v1"` —
 * the v1 mark is what makes the provider converters translate standard blocks
 * (`@langchain/core` alone recognises only legacy `source_type` blocks). Not
 * `contentBlocks:`: that form serializes without `kwargs.content`, which every
 * reader of a stored message (testing, episodes, hydration) looks at.
 */
function extractMessages(
  input: Record<string, unknown>,
  modality: MaterializedModality,
): ExtractedMessages {
  // LangGraph protocol format: {messages: [{role, content}, ...]}
  if (isInputMessageArray(input.messages)) {
    const dropped: DroppedPart[] = []
    const messages = input.messages
      .filter((msg) => msg.role === "user")
      .map((msg) => {
        const converted = convertUserContent(msg.content, modality)
        dropped.push(...converted.dropped)
        return typeof converted.content === "string"
          ? new HumanMessage(converted.content)
          : new HumanMessage({
              content: converted.content as unknown as MessageContent,
              response_metadata: V1_RESPONSE_METADATA,
            })
      })
    return { messages, dropped }
  }

  // Legacy flat-object format: {key: value, ...}
  return { messages: [new HumanMessage(formatAgentMessage(input))], dropped: [] }
}

/**
 * One message's content under the root model. A malformed entry drops on its
 * own (`malformed_part`) instead of sending the whole list to the flat-object
 * fallback, where it would stringify to `[object Object]`. Drop indices are the
 * entries' positions in the original list, in order.
 */
function convertUserContent(
  content: string | readonly unknown[],
  modality: MaterializedModality,
): ConvertedContent {
  if (typeof content === "string") {
    return toLangChainContent(content, modality.support, modality.provider, "user")
  }
  const valid: B4ContentPart[] = []
  const validIndices: number[] = []
  const malformed: DroppedPart[] = []
  for (const [index, entry] of content.entries()) {
    if (isContentPart(entry)) {
      valid.push(entry)
      validIndices.push(index)
      continue
    }
    const type =
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { type?: unknown }).type === "string"
        ? (entry as { type: string }).type
        : "unknown"
    malformed.push({ index, type, reason: "malformed_part" })
  }
  const converted = toLangChainContent(valid, modality.support, modality.provider, "user")
  const dropped = [
    ...converted.dropped.map((part) => ({
      ...part,
      index: validIndices[part.index] ?? part.index,
    })),
    ...malformed,
  ].sort((a, b) => a.index - b.index)
  return { content: converted.content, dropped }
}

function droppedPartsChunk(
  modality: MaterializedModality,
  dropped: readonly DroppedPart[],
): AgentStreamChunk {
  return { type: "content_parts_dropped", data: droppedPartsData(modality, dropped) }
}

function formatAgentMessage(input: Record<string, unknown>): string {
  const entries = Object.entries(input)

  if (entries.length === 0) {
    return ""
  }

  if (entries.length === 1) {
    return String(entries[0]?.[1])
  }

  return entries.map(([key, value]) => `${key}: ${String(value)}`).join("\n")
}
