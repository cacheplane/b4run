import type {
  ActivitySnapshotEvent,
  ContentPart,
  CustomEvent,
  Interrupt,
  ReasoningEndEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
  ReasoningStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core"
import { EventType, PROTOCOL_VERSION } from "@ag-ui/core"
import { isContentPartArray } from "@b4run/sdk"
import { createB4ActivityProjector, isB4ActivityChunkType } from "./activities.js"
import { createDefaultIdFactory, type IdFactory } from "./ids.js"
import { toAguiInterrupt } from "./interrupts.js"
import { createOrchestrationLedger } from "./orchestration-ledger.js"
import {
  asToolCallArgsData,
  asToolCallData,
  asToolResultData,
  asUsageData,
  type B4AgentStreamChunk,
  type RunContext,
} from "./types.js"
import { createUsageCollector } from "./usage.js"

/** The AG-UI events this mapper can emit. */
export type AguiOutboundEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | ActivitySnapshotEvent
  | CustomEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent

/** The CUSTOM event name for the spec's lossy-downgrade warning. */
export const B4_CONTENT_PARTS_DROPPED_EVENT = "b4.content_parts_dropped"

/** One invocation's open reasoning: the span and the message inside it. */
interface OpenReasoning {
  readonly spanId: string
  readonly messageId: string
}

export interface ToAguiOptions {
  readonly idFactory?: IdFactory
  /**
   * Asked once, when the upstream stream throws: `true` means whoever was
   * running the turn stopped it (a cancel endpoint, a server shutdown), and
   * the run ends `RUN_FINISHED { outcome: cancelled }` — stopped, not failed,
   * nothing to resume. `false` or absent: the throw is a failure, `RUN_ERROR`.
   */
  readonly cancelled?: () => boolean
  /**
   * Asked when the run ends in success: the client-provided tool calls this
   * turn left parked, awaiting the client's results. 1.0 ends such a turn as
   * success with `pendingToolCallIds`, never as an interrupt. Absent or empty
   * means none, and the key is then omitted (never `[]`).
   */
  readonly pendingToolCallIds?: () => readonly string[]
}

function stringifyArgs(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "{}"
  } catch {
    return "{}"
  }
}

/**
 * A tool result's wire content. A part array (the tool returned parts, or a
 * ToolMessage kept them under `additional_kwargs.b4_content_parts` so the UI
 * sees every part even when the model saw less) travels as parts; anything
 * else is text, as before. `toolCallId` picks the right ToolMessage out of a
 * `Command`-wrapped result.
 */
function toResultContent(output: unknown, toolCallId: string | undefined): string | ContentPart[] {
  if (isContentPartArray(output) && output.length > 0) return [...output]
  const kept = keptParts(output, toolCallId)
  if (kept) return kept
  if (typeof output === "string") return output
  if (output === undefined || output === null) return ""
  try {
    const serialized = JSON.stringify(output)
    return typeof serialized === "string" ? serialized : String(output)
  } catch {
    return String(output)
  }
}

type Indexable = { readonly [key: string]: unknown }

function asRecord(value: unknown): Indexable | undefined {
  return typeof value === "object" && value !== null ? (value as Indexable) : undefined
}

/**
 * The parts a tool result kept for the UI, or `undefined`. Two carriers:
 *
 * - A ToolMessage, live or serialized (`{ lc, type: "constructor", kwargs }`),
 *   with `additional_kwargs.b4_content_parts`. Its `content` (blocks, with
 *   `response_metadata.output_version`) is what the model saw and may be
 *   narrower; the kept parts are preferred whenever present.
 * - A LangGraph `Command` (a tool that returned `{ result, state }`), whose
 *   `update.messages` holds that ToolMessage. Live and `JSON.stringify`d
 *   Commands share this shape (`{ lg_name: "Command", update, goto }`); a
 *   `kwargs.update` wrapper is accepted too. Among several ToolMessages
 *   carrying parts, the one whose `tool_call_id` is this result's wins, else
 *   the first.
 */
function keptParts(output: unknown, toolCallId: string | undefined): ContentPart[] | undefined {
  const record = asRecord(output)
  if (record === undefined) return undefined
  const own = messageKeptParts(record)
  if (own !== undefined) return own.parts
  const update = asRecord(record.update) ?? asRecord(asRecord(record.kwargs)?.update)
  const messages = update?.messages
  if (!Array.isArray(messages)) return undefined
  let first: ContentPart[] | undefined
  for (const message of messages) {
    const entry = messageKeptParts(asRecord(message))
    if (entry === undefined) continue
    if (toolCallId !== undefined && entry.toolCallId === toolCallId) return entry.parts
    first ??= entry.parts
  }
  return first
}

/** `additional_kwargs.b4_content_parts` off one live or serialized ToolMessage. */
function messageKeptParts(
  message: Indexable | undefined,
): { readonly parts: ContentPart[]; readonly toolCallId: unknown } | undefined {
  if (message === undefined) return undefined
  const kwargs = asRecord(message.kwargs)
  const additional = asRecord(message.additional_kwargs) ?? asRecord(kwargs?.additional_kwargs)
  const parts = additional?.b4_content_parts
  if (!isContentPartArray(parts) || parts.length === 0) return undefined
  return { parts: [...parts], toolCallId: message.tool_call_id ?? kwargs?.tool_call_id }
}

/**
 * Map a B4.run agent stream (`token | tool_call | tool_result | interrupt |
 * done`) to AG-UI events, including snapshots for recognized B4.run plan and
 * subagent activity chunks. Stateful: it frames assistant text and tool calls
 * that B4.run emits implicitly, and it never throws into the consumer - an
 * upstream error becomes a `RUN_ERROR` event and a clean return.
 */
export async function* toAguiEvents(
  chunks: AsyncIterable<B4AgentStreamChunk>,
  ctx: RunContext,
  options: ToAguiOptions = {},
): AsyncGenerator<AguiOutboundEvent> {
  const nextId = options.idFactory ?? createDefaultIdFactory()
  const activityProjector = createB4ActivityProjector(ctx.runId)
  const ledger = createOrchestrationLedger()
  const usage = createUsageCollector()
  let openMessageId: string | null = null
  const identifiedMessages = new Map<string, string>()
  /**
   * Reasoning is framed per model invocation like text: one span and one
   * message, opened on the first delta. The span and message ids are distinct
   * from each other and from the invocation's text message id — the 1.0
   * reducer warns when one id is shared across text, reasoning and activity
   * messages.
   */
  let openReasoning: OpenReasoning | null = null
  const identifiedReasoning = new Map<string, OpenReasoning>()
  const pendingFallbackToolCallIds = new Map<string, string[]>()
  const pendingInterrupts: Interrupt[] = []
  /**
   * Tool calls opened by streamed argument deltas and not yet ended, with the
   * text sent so far. Only tools outside the orchestration set ever stream,
   * so their frames route as passthrough events; see the `tool_call` case for
   * how the announce closes one.
   */
  const openStreamedToolCalls = new Map<string, string>()

  function successOutcome(): NonNullable<RunFinishedEvent["outcome"]> {
    const pending = options.pendingToolCallIds?.() ?? []
    return pending.length > 0
      ? { type: "success", pendingToolCallIds: [...pending] }
      : { type: "success" }
  }

  function* closeReasoning(open: OpenReasoning): Generator<AguiOutboundEvent> {
    yield* ledger.onPassthrough({
      type: EventType.REASONING_MESSAGE_END,
      messageId: open.messageId,
    })
    yield* ledger.onPassthrough({ type: EventType.REASONING_END, messageId: open.spanId })
  }

  /** Anonymous reasoning closes at every boundary anonymous text does. */
  function* flushReasoning(): Generator<AguiOutboundEvent> {
    if (openReasoning !== null) {
      const open = openReasoning
      openReasoning = null
      yield* closeReasoning(open)
    }
  }

  function* openReasoningFrame(): Generator<AguiOutboundEvent, OpenReasoning> {
    const open: OpenReasoning = { spanId: nextId("reasoningSpan"), messageId: nextId("reasoning") }
    yield* ledger.onPassthrough({ type: EventType.REASONING_START, messageId: open.spanId })
    yield* ledger.onPassthrough({
      type: EventType.REASONING_MESSAGE_START,
      messageId: open.messageId,
      role: "reasoning",
    })
    return open
  }

  function* flushText(): Generator<AguiOutboundEvent> {
    yield* flushReasoning()
    if (openMessageId !== null) {
      const end: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId: openMessageId,
      }
      openMessageId = null
      yield* ledger.onPassthrough(end)
    }
  }

  /** End an invocation: its reasoning (span and message), then its text. */
  function* closeIdentified(sourceId: string): Generator<AguiOutboundEvent> {
    const reasoning = identifiedReasoning.get(sourceId)
    if (reasoning !== undefined) {
      identifiedReasoning.delete(sourceId)
      yield* closeReasoning(reasoning)
    }
    const messageId = identifiedMessages.get(sourceId)
    if (messageId === undefined) return
    identifiedMessages.delete(sourceId)
    yield* ledger.onPassthrough({ type: EventType.TEXT_MESSAGE_END, messageId })
  }

  function* flushAllText(): Generator<AguiOutboundEvent> {
    yield* flushText()
    for (const sourceId of new Set([...identifiedReasoning.keys(), ...identifiedMessages.keys()])) {
      yield* closeIdentified(sourceId)
    }
  }

  /** A terminal boundary reached with streamed calls still open: end them. */
  function* closeStreamedToolCalls(): Generator<AguiOutboundEvent> {
    for (const toolCallId of openStreamedToolCalls.keys()) {
      yield* ledger.onPassthrough({ type: EventType.TOOL_CALL_END, toolCallId })
    }
    openStreamedToolCalls.clear()
  }

  // The producer's own version, never an echo of the input's (spec: versioning).
  yield {
    type: EventType.RUN_STARTED,
    threadId: ctx.threadId,
    runId: ctx.runId,
    protocolVersion: PROTOCOL_VERSION,
  }

  try {
    for await (const chunk of chunks) {
      if (chunk.type !== "interrupt" && pendingInterrupts.length > 0) {
        if (chunk.type === "done") {
          yield* closeStreamedToolCalls()
          yield* ledger.settle()
          yield {
            type: EventType.RUN_FINISHED,
            threadId: ctx.threadId,
            runId: ctx.runId,
            outcome: { type: "interrupt", interrupts: pendingInterrupts },
            ...usage.terminal(),
          }
          return
        }
        continue
      }

      if (isB4ActivityChunkType(chunk.type)) {
        const projection = activityProjector.project(chunk.type, chunk.data)
        if (projection.event !== null) {
          yield* ledger.onActivity(projection.event, projection.orchestration)
        }
        continue
      }

      switch (chunk.type) {
        case "token": {
          const delta = typeof chunk.data === "string" ? chunk.data : ""
          if (delta.length === 0) break
          const sourceId =
            "messageId" in chunk &&
            typeof chunk.messageId === "string" &&
            chunk.messageId.length > 0
              ? chunk.messageId
              : undefined
          if (sourceId !== undefined) {
            yield* flushText()
            let messageId = identifiedMessages.get(sourceId)
            if (messageId === undefined) {
              messageId = nextId("message")
              identifiedMessages.set(sourceId, messageId)
              yield* ledger.onPassthrough({
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              })
            }
            yield* ledger.onPassthrough({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta })
            break
          }
          if (openMessageId === null) {
            openMessageId = nextId("message")
            yield* ledger.onPassthrough({
              type: EventType.TEXT_MESSAGE_START,
              messageId: openMessageId,
              role: "assistant",
            })
          }
          yield* ledger.onPassthrough({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: openMessageId,
            delta,
          })
          break
        }
        case "reasoning": {
          const delta = typeof chunk.data === "string" ? chunk.data : ""
          if (delta.length === 0) break
          const sourceId =
            "messageId" in chunk &&
            typeof chunk.messageId === "string" &&
            chunk.messageId.length > 0
              ? chunk.messageId
              : undefined
          if (sourceId !== undefined) {
            // An identified delta means the producer identifies invocations, so
            // anonymous reasoning belongs to nothing current. This invocation's
            // own text stays open: reasoning and text interleave until
            // `message_end`.
            yield* flushReasoning()
            let open = identifiedReasoning.get(sourceId)
            if (open === undefined) {
              open = yield* openReasoningFrame()
              identifiedReasoning.set(sourceId, open)
            }
            yield* ledger.onPassthrough({
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: open.messageId,
              delta,
            })
            break
          }
          if (openReasoning === null) openReasoning = yield* openReasoningFrame()
          yield* ledger.onPassthrough({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: openReasoning.messageId,
            delta,
          })
          break
        }
        case "message_end": {
          const data = chunk.data
          if (
            data &&
            typeof data === "object" &&
            "messageId" in data &&
            typeof data.messageId === "string"
          ) {
            yield* closeIdentified(data.messageId)
          }
          break
        }
        case "tool_call_args": {
          const fragment = asToolCallArgsData(chunk.data)
          if (!fragment) break
          const sent = openStreamedToolCalls.get(fragment.id)
          if (sent === undefined) {
            yield* flushText()
            openStreamedToolCalls.set(fragment.id, "")
            yield* ledger.onPassthrough({
              type: EventType.TOOL_CALL_START,
              toolCallId: fragment.id,
              toolCallName: fragment.name,
            })
          }
          if (fragment.delta.length === 0) break
          openStreamedToolCalls.set(fragment.id, (sent ?? "") + fragment.delta)
          yield* ledger.onPassthrough({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: fragment.id,
            delta: fragment.delta,
          })
          break
        }
        case "tool_call": {
          yield* flushText()
          const tc = asToolCallData(chunk.data)
          if (!tc) break
          const sent = tc.id === undefined ? undefined : openStreamedToolCalls.get(tc.id)
          if (tc.id !== undefined && sent !== undefined) {
            // The deltas already opened this call. The announce carries the
            // complete input, so anything the deltas did not cover goes out as
            // one last delta; the concatenation is then exactly the single
            // delta a non-streamed call carries. A payload that does not
            // extend the streamed text cannot be corrected, only ended.
            openStreamedToolCalls.delete(tc.id)
            const full = stringifyArgs(tc.input)
            if (full.length > sent.length && full.startsWith(sent)) {
              yield* ledger.onPassthrough({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: tc.id,
                delta: full.slice(sent.length),
              })
            }
            yield* ledger.onPassthrough({ type: EventType.TOOL_CALL_END, toolCallId: tc.id })
            break
          }
          const toolCallId = tc.id ?? nextId("toolCall")
          if (tc.id === undefined) {
            const pending = pendingFallbackToolCallIds.get(tc.name)
            if (pending) {
              pending.push(toolCallId)
            } else {
              pendingFallbackToolCallIds.set(tc.name, [toolCallId])
            }
          }
          const frames: AguiOutboundEvent[] = [
            { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: tc.name },
            { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: stringifyArgs(tc.input) },
            { type: EventType.TOOL_CALL_END, toolCallId },
          ]
          yield* ledger.onToolCall(tc.id, tc.name, frames)
          break
        }
        case "tool_result": {
          yield* flushText()
          const tr = asToolResultData(chunk.data)
          if (!tr) break
          const pending = tr.id === undefined ? pendingFallbackToolCallIds.get(tr.name) : undefined
          const toolCallId = tr.id ?? pending?.shift() ?? nextId("toolCall")
          if (pending?.length === 0) pendingFallbackToolCallIds.delete(tr.name)
          const messageId = nextId("toolResult")
          const resultEvent: ToolCallResultEvent = {
            type: EventType.TOOL_CALL_RESULT,
            messageId,
            toolCallId,
            content: toResultContent(tr.output, tr.id),
          }
          yield* ledger.onToolResult(tr.id, tr.name, resultEvent)
          break
        }
        case "usage":
        case "subagent.usage": {
          // A child's model call is part of this run's usage (the run is the
          // accounting boundary), so both spellings land in one collector.
          const data = asUsageData(chunk.data)
          if (data) usage.add(data)
          break
        }
        case "interrupt": {
          yield* flushAllText()
          yield* closeStreamedToolCalls()
          const interrupt = toAguiInterrupt(chunk.data)
          if (interrupt === null) {
            yield* ledger.settle()
            yield {
              type: EventType.RUN_ERROR,
              message: "Malformed B4.run interrupt: missing interruptId",
              ...usage.terminal(),
            }
            return
          }
          // The resumed run re-presents this same call under the same logical
          // id, so flushing its frames here would leave an unreconcilable
          // duplicate on resume; see orchestration-ledger.ts's settle() for
          // the fuller rationale.
          yield* ledger.settle(interrupt.toolCallId)
          pendingInterrupts.push(interrupt)
          break
        }
        case "done": {
          yield* flushAllText()
          yield* closeStreamedToolCalls()
          yield* ledger.settle()
          yield {
            type: EventType.RUN_FINISHED,
            threadId: ctx.threadId,
            runId: ctx.runId,
            // 1.0: an absent result is omitted; null is not a result.
            ...(Object.hasOwn(chunk, "data") && chunk.data !== undefined && chunk.data !== null
              ? { result: chunk.data }
              : {}),
            outcome: successOutcome(),
            ...usage.terminal(),
          }
          return
        }
        case "content_parts_dropped": {
          // Not a protocol requirement: B4 frames text with START/CONTENT/END
          // (never CHUNK events), and the 1.0 client accepts a CUSTOM while a
          // message is open. Ending open text first is a tidiness choice, so
          // the drop notice lands between messages rather than inside one.
          yield* flushText()
          yield* ledger.onPassthrough({
            type: EventType.CUSTOM,
            name: B4_CONTENT_PARTS_DROPPED_EVENT,
            value: chunk.data,
          })
          break
        }
        default:
          yield* flushText()
          // Unknown extension chunks (e.g. capability.unknown) flush open text
          // and are ignored.
          break
      }
    }
    // Stream ended without an explicit done/interrupt: flush and finish.
    yield* flushAllText()
    yield* closeStreamedToolCalls()
    yield* ledger.settle()
    if (pendingInterrupts.length > 0) {
      yield {
        type: EventType.RUN_FINISHED,
        threadId: ctx.threadId,
        runId: ctx.runId,
        outcome: { type: "interrupt", interrupts: pendingInterrupts },
        ...usage.terminal(),
      }
      return
    }
    yield {
      type: EventType.RUN_FINISHED,
      threadId: ctx.threadId,
      runId: ctx.runId,
      outcome: successOutcome(),
      ...usage.terminal(),
    }
  } catch (err) {
    yield* flushAllText()
    yield* closeStreamedToolCalls()
    yield* ledger.settle()
    if (options.cancelled?.() === true) {
      yield {
        type: EventType.RUN_FINISHED,
        threadId: ctx.threadId,
        runId: ctx.runId,
        outcome: { type: "cancelled" },
        ...usage.terminal(),
      }
      return
    }
    // An upstream error that names a machine-readable `code` (the runtime's
    // middleware `after` rejection does) keeps it on the wire; anything else
    // stays message-only, exactly as before.
    const code =
      err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined
    yield {
      type: EventType.RUN_ERROR,
      message: err instanceof Error ? err.message : String(err),
      ...(code !== undefined ? { code } : {}),
      ...usage.terminal(),
    }
  }
}
