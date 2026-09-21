import type {
  ActivitySnapshotEvent,
  Interrupt,
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
import { EventType } from "@ag-ui/core"
import { createB4ActivityProjector, isB4ActivityChunkType } from "./activities.js"
import { createDefaultIdFactory, type IdFactory } from "./ids.js"
import { toAguiInterrupt } from "./interrupts.js"
import { createOrchestrationLedger } from "./orchestration-ledger.js"
import {
  asToolCallArgsData,
  asToolCallData,
  asToolResultData,
  type B4AgentStreamChunk,
  type RunContext,
} from "./types.js"

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

export interface ToAguiOptions {
  readonly idFactory?: IdFactory
}

function stringifyArgs(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "{}"
  } catch {
    return "{}"
  }
}

function stringifyContent(output: unknown): string {
  if (typeof output === "string") return output
  if (output === undefined || output === null) return ""
  try {
    const serialized = JSON.stringify(output)
    return typeof serialized === "string" ? serialized : String(output)
  } catch {
    return String(output)
  }
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
  let openMessageId: string | null = null
  const identifiedMessages = new Map<string, string>()
  const pendingFallbackToolCallIds = new Map<string, string[]>()
  const pendingInterrupts: Interrupt[] = []
  /**
   * Tool calls opened by streamed argument deltas and not yet ended, with the
   * text sent so far. Only tools outside the orchestration set ever stream,
   * so their frames route as passthrough events; see the `tool_call` case for
   * how the announce closes one.
   */
  const openStreamedToolCalls = new Map<string, string>()

  function* flushText(): Generator<AguiOutboundEvent> {
    if (openMessageId !== null) {
      const end: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId: openMessageId,
      }
      openMessageId = null
      yield* ledger.onPassthrough(end)
    }
  }

  function* closeIdentified(sourceId: string): Generator<AguiOutboundEvent> {
    const messageId = identifiedMessages.get(sourceId)
    if (messageId === undefined) return
    identifiedMessages.delete(sourceId)
    yield* ledger.onPassthrough({ type: EventType.TEXT_MESSAGE_END, messageId })
  }

  function* flushAllText(): Generator<AguiOutboundEvent> {
    yield* flushText()
    for (const sourceId of identifiedMessages.keys()) yield* closeIdentified(sourceId)
  }

  /** A terminal boundary reached with streamed calls still open: end them. */
  function* closeStreamedToolCalls(): Generator<AguiOutboundEvent> {
    for (const toolCallId of openStreamedToolCalls.keys()) {
      yield* ledger.onPassthrough({ type: EventType.TOOL_CALL_END, toolCallId })
    }
    openStreamedToolCalls.clear()
  }

  yield { type: EventType.RUN_STARTED, threadId: ctx.threadId, runId: ctx.runId }

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
            content: stringifyContent(tr.output),
          }
          yield* ledger.onToolResult(tr.id, tr.name, resultEvent)
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
            ...(Object.hasOwn(chunk, "data") && chunk.data !== undefined
              ? { result: chunk.data }
              : {}),
            outcome: { type: "success" },
          }
          return
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
      }
      return
    }
    yield {
      type: EventType.RUN_FINISHED,
      threadId: ctx.threadId,
      runId: ctx.runId,
      outcome: { type: "success" },
    }
  } catch (err) {
    yield* flushAllText()
    yield* closeStreamedToolCalls()
    yield* ledger.settle()
    // An upstream error that names a machine-readable `code` (the runtime's
    // middleware `after` rejection does) keeps it on the wire; anything else
    // stays message-only, exactly as before.
    const code =
      err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined
    yield {
      type: EventType.RUN_ERROR,
      message: err instanceof Error ? err.message : String(err),
      ...(code !== undefined ? { code } : {}),
    }
  }
}
