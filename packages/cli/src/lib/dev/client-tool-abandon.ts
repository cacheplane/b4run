/**
 * Closing abandoned client tool calls in the checkpoint (cacheplane/b4run#743,
 * Model A).
 *
 * A client tool call parks its `tools` task with `interrupt()`. When the
 * client never answers it — it sends a new user message instead, or the call
 * expired — the thread must be freed: each parked call gets a tool result
 * (`ABANDONED_CLIENT_TOOL_RESULT`, or the client's stored result for a call it
 * did answer) and the park must be gone, so the next turn runs normally and
 * the model's history has a ToolMessage for every tool call it made.
 *
 * Mechanism: ONE `graph.updateState(..., { messages: [ToolMessage...] },
 * "tools")`, as if the `tools` node had produced those results. LangGraph's
 * `updateState` first applies the parked superstep's successful pending
 * writes and drops its `__interrupt__` writes, then applies ours. So:
 *   - a sibling SERVER tool that completed in the same superstep keeps its
 *     ToolMessage (it was only a pending write), ahead of ours;
 *   - no park remains pending; the checkpoint's next node is the model.
 * The stub is never re-executed and no resume key is needed, so a park whose
 * resume key or envelope is unusable (the "unanswerable" abandon) closes the
 * same way. Chosen over resuming the parks under a runtime `interruptBefore`
 * for exactly that reason; both passed the spike otherwise.
 *
 * What the caller runs next, through its ordinary streaming path:
 *   - a new user message follows: an ordinary turn with that message as input;
 *   - no new message (the call expired while the client's last message was a
 *     tool message): a turn with `resume: CONTINUE_AFTER_CLOSE` — an empty
 *     resume map, which continues from the closed checkpoint so the model
 *     replies to the closed calls. Not `{ messages: [] }`: the agent adapter
 *     reads an empty message list as a legacy flat input and would append an
 *     empty user message.
 * Closing is the same in both cases, so this function takes no flag for it.
 *
 * Difference from a real tool result, stated: the ToolMessage is written
 * directly, so the route's result offloading and `tool_result` stream
 * transformers do not see it, and no tool_result frame is streamed for it.
 *
 * Preconditions, each enforced by a throw before anything is written:
 *   - every pending park is a client tool park. A permission park pending
 *     alongside is `non_client_park_pending`: the handler refuses abandonment
 *     with 409 `resume_required`, as the approval flow does. An `__interrupt__`
 *     write the parser could not identify counts as non-client (fail closed).
 *   - at least one client park is pending (`no_client_park`).
 *   - `calls` names exactly the latest assistant message's unresolved tool
 *     calls, each a `client_`-prefixed one: an id that is not unresolved there
 *     is `unknown_call` (a server tool's call, a stale id, a duplicate); an
 *     unresolved call left out is `unclosed_call` — including a client park
 *     whose envelope lost its tool-call id, and a task that failed rather than
 *     parked. Either would leave a tool call with no ToolMessage, which the
 *     provider rejects on the next model call.
 * Postcondition, re-read after the write: no park pending and no unresolved
 * tool call (`close_incomplete` otherwise).
 *
 * Not atomic against a concurrent run on the same thread: the caller holds
 * the thread's run slot across the close and the turn that follows.
 */
import { CLIENT_TOOL_PREFIX } from "@b4run/core"
import { type BaseMessage, ToolMessage } from "@langchain/core/messages"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"

import { isClientToolPark, parsePendingInterrupts } from "./pending-interrupts.js"

/** One parked client tool call to close, with the result the model will see. */
export interface AbandonedClientToolCall {
  /** The provider's tool-call id — the park envelope's `toolCallId`. */
  readonly toolCallId: string
  /** The un-prefixed name the client registered; informational. */
  readonly toolName: string
  /** `ABANDONED_CLIENT_TOOL_RESULT`, or the client's stored result. */
  readonly result: string
}

/**
 * The slice of a compiled LangGraph agent graph this needs — what
 * `materializeResolvedRouteGraph` returns, bound to the thread's checkpointer.
 * Materialize it with the parked run's `clientTools` so the graph matches the
 * checkpoint's.
 */
export interface ClosableAgentGraph {
  getState(config: { readonly configurable: Record<string, unknown> }): Promise<{
    readonly values: unknown
  }>
  updateState(
    config: { readonly configurable: Record<string, unknown> },
    values: Record<string, unknown>,
    asNode?: string,
  ): Promise<unknown>
}

export interface CloseAbandonedClientToolCallsOptions {
  readonly graph: ClosableAgentGraph
  /** The same checkpointer the graph is bound to; read for the pending parks. */
  readonly checkpointer: BaseCheckpointSaver
  readonly threadId: string
  readonly calls: readonly AbandonedClientToolCall[]
}

export interface ClosedClientToolCalls {
  /** In the order the model emitted them. */
  readonly closedToolCallIds: readonly string[]
}

/** The resume map that continues a thread whose client calls were closed, when no new user message follows. */
export const CONTINUE_AFTER_CLOSE: Readonly<Record<string, never>> = Object.freeze({})

export type ClientToolAbandonErrorCode =
  | "non_client_park_pending"
  | "no_client_park"
  | "unknown_call"
  | "unclosed_call"
  | "close_incomplete"

export class ClientToolAbandonError extends Error {
  readonly code: ClientToolAbandonErrorCode
  constructor(code: ClientToolAbandonErrorCode, message: string) {
    super(message)
    this.name = "ClientToolAbandonError"
    this.code = code
  }
}

export async function closeAbandonedClientToolCalls(
  options: CloseAbandonedClientToolCallsOptions,
): Promise<ClosedClientToolCalls> {
  const { graph, checkpointer, threadId, calls } = options
  // Root namespace and no checkpoint_id: updateState only folds the parked
  // superstep's pending writes in when it targets the thread's latest checkpoint.
  const config = { configurable: { thread_id: threadId, checkpoint_ns: "" } }

  const parks = await readParks(checkpointer, threadId)
  if (parks.unidentified > 0 || parks.nonClient > 0) {
    throw new ClientToolAbandonError(
      "non_client_park_pending",
      "A non-client park is pending on this thread; it must be resumed before client tool calls can be abandoned",
    )
  }
  if (parks.client === 0) {
    throw new ClientToolAbandonError(
      "no_client_park",
      "No client tool call is parked on this thread",
    )
  }

  const unresolved = unresolvedToolCalls(await readMessages(graph, config))
  const byId = new Map(
    unresolved.flatMap((call) => (call.id === undefined ? [] : [[call.id, call] as const])),
  )
  const given = new Map<string, AbandonedClientToolCall>()
  for (const call of calls) {
    const target = byId.get(call.toolCallId)
    if (!target?.name.startsWith(CLIENT_TOOL_PREFIX) || given.has(call.toolCallId)) {
      throw new ClientToolAbandonError(
        "unknown_call",
        `Tool call ${call.toolCallId} is not an unresolved client tool call on this thread`,
      )
    }
    given.set(call.toolCallId, call)
  }
  const missing = unresolved.filter((call) => call.id === undefined || !given.has(call.id))
  if (missing.length > 0) {
    throw new ClientToolAbandonError(
      "unclosed_call",
      `Unresolved tool call(s) not closed: ${missing.map((call) => call.id ?? call.name).join(", ")}`,
    )
  }

  const messages = unresolved.map(
    (call) =>
      new ToolMessage({
        content: (given.get(call.id as string) as AbandonedClientToolCall).result,
        name: call.name,
        tool_call_id: call.id as string,
      }),
  )
  await graph.updateState(config, { messages }, "tools")

  const after = await readParks(checkpointer, threadId)
  const stillUnresolved = unresolvedToolCalls(await readMessages(graph, config))
  if (after.total > 0 || stillUnresolved.length > 0) {
    throw new ClientToolAbandonError(
      "close_incomplete",
      "Closing the client tool calls left a park pending or a tool call unresolved",
    )
  }
  return { closedToolCallIds: unresolved.map((call) => call.id as string) }
}

interface ParkCounts {
  readonly total: number
  readonly client: number
  readonly nonClient: number
  /** `__interrupt__` writes the parser dropped entirely: unknown kind. */
  readonly unidentified: number
}

async function readParks(checkpointer: BaseCheckpointSaver, threadId: string): Promise<ParkCounts> {
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId, checkpoint_ns: "" },
  })
  if (!tuple) return { total: 0, client: 0, nonClient: 0, unidentified: 0 }
  const raw = (tuple.pendingWrites ?? []).filter(
    (write) => Array.isArray(write) && write[1] === "__interrupt__",
  ).length
  const { interrupts } = parsePendingInterrupts(tuple)
  // Client-typed but envelope-malformed still counts as client: that is the
  // "unanswerable" abandon, and its call is matched by id below or refused.
  const client = interrupts.filter((entry) => isClientToolPark(entry.value)).length
  return {
    total: raw,
    client,
    nonClient: interrupts.length - client,
    unidentified: Math.max(0, raw - interrupts.length),
  }
}

async function readMessages(
  graph: ClosableAgentGraph,
  config: { readonly configurable: Record<string, unknown> },
): Promise<readonly BaseMessage[]> {
  // getState folds the parked superstep's successful pending writes into
  // `values`, so a completed sibling tool's ToolMessage is visible here.
  const state = await graph.getState(config)
  const messages = (state.values as { messages?: unknown } | undefined)?.messages
  return Array.isArray(messages) ? (messages as BaseMessage[]) : []
}

interface ToolCallRef {
  /** `undefined` for a provider call with no id: it cannot be closed, so it is refused. */
  readonly id: string | undefined
  readonly name: string
}

/** The latest assistant message's tool calls that no later ToolMessage answers. */
function unresolvedToolCalls(messages: readonly BaseMessage[]): ToolCallRef[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as BaseMessage & {
      tool_calls?: ReadonlyArray<{ id?: string; name: string }>
    }
    if (message._getType() !== "ai") continue
    const answered = new Set(
      messages
        .slice(index + 1)
        .filter((later) => later._getType() === "tool")
        .map((later) => (later as ToolMessage).tool_call_id),
    )
    return (message.tool_calls ?? [])
      .filter((call) => call.id === undefined || !answered.has(call.id))
      .map((call) => ({ id: typeof call.id === "string" ? call.id : undefined, name: call.name }))
  }
  return []
}
