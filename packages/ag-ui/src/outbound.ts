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
  SubagentErrorEvent,
  SubagentFinishedEvent,
  SubagentStartedEvent,
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
import { createB4ActivityProjector } from "./activities.js"
import { createDefaultIdFactory, type IdFactory } from "./ids.js"
import { toAguiInterrupt } from "./interrupts.js"
import { createOrchestrationLedger } from "./orchestration-ledger.js"
import { B4_STEP_EVENT_NAME, type B4StepEventValue } from "./step.js"
import { asSubagentEndData, asSubagentStartData, unwrapSubagentChunk } from "./subagent-chunks.js"
import {
  asStepData,
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
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | SubagentErrorEvent

/** The CUSTOM event name for the spec's lossy-downgrade warning. */
export const B4_CONTENT_PARTS_DROPPED_EVENT = "b4.content_parts_dropped"

/** One invocation's open reasoning: the span and the message inside it. */
interface OpenReasoning {
  readonly spanId: string
  readonly messageId: string
}

/**
 * The framing state of one owner: the root agent (`undefined`) or one
 * announced subagent, keyed by its `call_id`. A child is framed exactly as
 * root is, from the same code, and every event it produces is tagged with its
 * `subagentRunId` (= `call_id`) on the way out.
 */
interface OwnerState {
  openMessageId: string | null
  readonly identifiedMessages: Map<string, string>
  /**
   * Reasoning is framed per model invocation like text: one span and one
   * message, opened on the first delta. The span and message ids are distinct
   * from each other and from the invocation's text message id — the 1.0
   * reducer warns when one id is shared across text, reasoning and activity
   * messages.
   */
  openReasoning: OpenReasoning | null
  readonly identifiedReasoning: Map<string, OpenReasoning>
  /**
   * Tool calls opened by streamed argument deltas and not yet ended, with the
   * text sent so far. Only tools outside the orchestration set ever stream,
   * so their frames route as passthrough events; see the `tool_call` case for
   * how the announce closes one.
   */
  readonly openStreamedToolCalls: Map<string, string>
  readonly pendingFallbackToolCallIds: Map<string, string[]>
  /**
   * Every model invocation's AG-UI message id, kept after its text ends: the
   * calls an invocation announces (at its end, after its `message_end`) carry
   * that id as `parentMessageId`, so a host that builds its message list from
   * events holds the invocation's text and its calls in one assistant
   * message — and has an assistant message for a tool-only invocation too.
   */
  readonly modelMessages: Map<string, string>
  /** Invocations whose text already ended: a late delta opens a fresh message. */
  readonly endedModelText: Set<string>
  /**
   * The parent of a call whose producer names no invocation: the anonymous
   * text just before it, else a fresh id shared by the calls up to the next
   * result or text.
   */
  anonymousParent: string | null
}

/** An announced subagent invocation that has not closed yet. */
interface OpenSubagent {
  readonly callId: string
  readonly parentCallId: string | undefined
}

type Owner = string | undefined

/** Why every still-open subagent is being closed at a terminal boundary. */
type SubagentCloseReason =
  | { readonly kind: "interrupt"; readonly interrupts: readonly Interrupt[] }
  | { readonly kind: "unterminated" }
  | { readonly kind: "cancelled" }

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
   * means none, and the key is then omitted (never `[]`). May be asynchronous:
   * the runtime reads them from its tool-call record.
   * A rejection ends the run as RUN_ERROR rather than reporting nothing pending.
   */
  readonly pendingToolCallIds?: () => readonly string[] | Promise<readonly string[]>
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
function toResultContent(
  output: unknown,
  toolCallId: string | undefined,
  view: ToolResultView,
): string | ContentPart[] {
  if (isContentPartArray(output) && output.length > 0) return [...output]
  const kept = keptParts(output, toolCallId)
  if (kept) return kept
  // No parts kept: the text the model saw (a ToolMessage's content, a
  // Command's last ToolMessage, or a bare value serialized).
  return view.content
}

/** A bare value as result text: a string as-is, null/undefined empty, else JSON. */
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A ToolMessage's fields, whether the value is the live instance (fields on
 * the object) or its serialized form (fields under `kwargs`). Anything
 * without a string `tool_call_id` is not a ToolMessage.
 */
function readToolMessageFields(
  value: unknown,
): { readonly content: unknown; readonly status: unknown } | undefined {
  if (!isPlainObject(value)) return undefined
  const fields = isPlainObject(value.kwargs) ? value.kwargs : value
  if (typeof fields.tool_call_id !== "string") return undefined
  return { content: fields.content, status: fields.status }
}

/** A ToolMessage's text: a string as-is, content parts joined by their text parts. */
function contentText(content: unknown): string {
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
        texts.push(part.text)
      }
    }
    return texts.join(" ")
  }
  return stringifyContent(content)
}

/** What a tool result looks like on the wire: the text the model saw, and whether the tool failed. */
export interface ToolResultView {
  readonly content: string
  readonly failed: boolean
}

/**
 * The adapter forwards LangGraph's `on_tool_end` output unchanged: a
 * ToolMessage for a string-returning tool, a Command whose `update.messages`
 * ends in one for a `{result, state}` tool, or the error ToolMessage for a
 * tool that threw. The protocol wants the tool's output, so unwrap all three;
 * a bare value (tests, third-party producers) is serialized as before.
 */
export function toolResultView(output: unknown): ToolResultView {
  try {
    const direct = readToolMessageFields(output)
    if (direct !== undefined) {
      return { content: contentText(direct.content), failed: direct.status === "error" }
    }
    if (
      isPlainObject(output) &&
      isPlainObject(output.update) &&
      Array.isArray(output.update.messages)
    ) {
      const messages = output.update.messages
      for (let index = messages.length - 1; index >= 0; index--) {
        const fields = readToolMessageFields(messages[index])
        if (fields !== undefined) {
          return { content: contentText(fields.content), failed: fields.status === "error" }
        }
      }
    }
  } catch {
    // A hostile getter or Proxy must not escape the stream; serialize instead.
  }
  return { content: stringifyContent(output), failed: false }
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

function newOwnerState(): OwnerState {
  return {
    openMessageId: null,
    identifiedMessages: new Map(),
    openReasoning: null,
    identifiedReasoning: new Map(),
    openStreamedToolCalls: new Map(),
    pendingFallbackToolCallIds: new Map(),
    modelMessages: new Map(),
    endedModelText: new Set(),
    anonymousParent: null,
  }
}

/** A child's event carries its owner; root events are never tagged (never `null`). */
function tag<E extends AguiOutboundEvent>(owner: Owner, event: E): E {
  return owner === undefined ? event : { ...event, subagentRunId: owner }
}

function stepEvent(owner: Owner, value: B4StepEventValue): CustomEvent {
  return tag(owner, { type: EventType.CUSTOM, name: B4_STEP_EVENT_NAME, value })
}

/**
 * Map a B4.run agent stream (`token | reasoning | tool_call | tool_result |
 * plan_update | usage | subagent.* | interrupt | done`) to AG-UI events.
 * Stateful: it frames assistant text, reasoning and tool calls that B4.run
 * emits implicitly — for the root agent and, identically, for every announced
 * subagent, whose events carry its `subagentRunId` — presents a subagent's
 * lifecycle as `SUBAGENT_STARTED/FINISHED/ERROR`, and it never throws into the
 * consumer: an upstream error becomes a `RUN_ERROR` event and a clean return.
 *
 * 1.0 discipline, owned here: nothing this mapper opens — a text message, a
 * reasoning span or message, a tool call, a subagent — survives `RUN_FINISHED`.
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
  const owners = new Map<Owner, OwnerState>()
  /** Insertion-ordered: a child is announced after its parent, so reverse order is deepest first. */
  const openSubagents = new Map<string, OpenSubagent>()
  const pendingInterrupts: Interrupt[] = []

  function stateFor(owner: Owner): OwnerState {
    let state = owners.get(owner)
    if (state === undefined) {
      state = newOwnerState()
      owners.set(owner, state)
    }
    return state
  }

  function* emit(owner: Owner, event: AguiOutboundEvent): Generator<AguiOutboundEvent> {
    yield* ledger.onPassthrough(tag(owner, event))
  }

  async function successOutcome(): Promise<NonNullable<RunFinishedEvent["outcome"]>> {
    const pending = (await options.pendingToolCallIds?.()) ?? []
    return pending.length > 0
      ? { type: "success", pendingToolCallIds: [...pending] }
      : { type: "success" }
  }

  function* closeReasoning(owner: Owner, open: OpenReasoning): Generator<AguiOutboundEvent> {
    yield* emit(owner, { type: EventType.REASONING_MESSAGE_END, messageId: open.messageId })
    yield* emit(owner, { type: EventType.REASONING_END, messageId: open.spanId })
  }

  /** Anonymous reasoning closes at every boundary anonymous text does. */
  function* flushReasoning(owner: Owner): Generator<AguiOutboundEvent> {
    const state = stateFor(owner)
    if (state.openReasoning !== null) {
      const open = state.openReasoning
      state.openReasoning = null
      yield* closeReasoning(owner, open)
    }
  }

  /**
   * The AG-UI message id of the model invocation `sourceId` names (the id its
   * text uses), or — for a producer that names none — the anonymous parent.
   */
  function modelMessageId(state: OwnerState, sourceId: string | undefined): string {
    if (sourceId === undefined) {
      state.anonymousParent ??= nextId("message")
      return state.anonymousParent
    }
    let messageId = state.modelMessages.get(sourceId)
    if (messageId === undefined) {
      messageId = nextId("message")
      state.modelMessages.set(sourceId, messageId)
    }
    return messageId
  }

  function* openReasoningFrame(owner: Owner): Generator<AguiOutboundEvent, OpenReasoning> {
    const open: OpenReasoning = { spanId: nextId("reasoningSpan"), messageId: nextId("reasoning") }
    yield* emit(owner, { type: EventType.REASONING_START, messageId: open.spanId })
    yield* emit(owner, {
      type: EventType.REASONING_MESSAGE_START,
      messageId: open.messageId,
      role: "reasoning",
    })
    return open
  }

  function* flushText(owner: Owner): Generator<AguiOutboundEvent> {
    yield* flushReasoning(owner)
    const state = stateFor(owner)
    if (state.openMessageId !== null) {
      const end: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId: state.openMessageId,
      }
      state.openMessageId = null
      yield* emit(owner, end)
    }
  }

  /** End an invocation: its reasoning (span and message), then its text. */
  function* closeIdentified(owner: Owner, sourceId: string): Generator<AguiOutboundEvent> {
    const state = stateFor(owner)
    const reasoning = state.identifiedReasoning.get(sourceId)
    if (reasoning !== undefined) {
      state.identifiedReasoning.delete(sourceId)
      yield* closeReasoning(owner, reasoning)
    }
    const messageId = state.identifiedMessages.get(sourceId)
    if (messageId === undefined) return
    state.identifiedMessages.delete(sourceId)
    state.endedModelText.add(sourceId)
    yield* emit(owner, { type: EventType.TEXT_MESSAGE_END, messageId })
  }

  function* flushAllText(owner: Owner): Generator<AguiOutboundEvent> {
    yield* flushText(owner)
    const state = stateFor(owner)
    const sources = new Set([
      ...state.identifiedReasoning.keys(),
      ...state.identifiedMessages.keys(),
    ])
    for (const sourceId of sources) yield* closeIdentified(owner, sourceId)
  }

  /** A terminal boundary reached with streamed calls still open: end them. */
  function* closeStreamedToolCalls(owner: Owner): Generator<AguiOutboundEvent> {
    const state = stateFor(owner)
    for (const toolCallId of state.openStreamedToolCalls.keys()) {
      yield* emit(owner, { type: EventType.TOOL_CALL_END, toolCallId })
    }
    state.openStreamedToolCalls.clear()
  }

  /** Everything one owner has open: text, reasoning, streamed tool calls. */
  function* flushOwner(owner: Owner): Generator<AguiOutboundEvent> {
    yield* flushAllText(owner)
    yield* closeStreamedToolCalls(owner)
  }

  function* flushEveryOwner(): Generator<AguiOutboundEvent> {
    for (const owner of [...owners.keys()]) yield* flushOwner(owner)
  }

  /**
   * Every announced invocation MUST close before the run finishes (spec:
   * subagents). An interrupt suspends them, naming the interrupts each one
   * raised; a cancel or a stream that ended early fails them, since no
   * `subagent.end` will come. `RUN_ERROR` abandons them: nothing is emitted.
   * Deepest first, so a parent closes after its child. Returns the ids that
   * were open, so the interrupt outcome can attribute each interrupt.
   */
  function* closeOpenSubagents(
    reason: SubagentCloseReason,
  ): Generator<AguiOutboundEvent, ReadonlySet<string>> {
    const closed = new Set<string>()
    for (const open of [...openSubagents.values()].reverse()) {
      yield* flushOwner(open.callId)
      closed.add(open.callId)
      if (reason.kind === "interrupt") {
        const interruptIds = reason.interrupts
          .filter((interrupt) => (interrupt.subagentRunId ?? interrupt.toolCallId) === open.callId)
          .map((interrupt) => interrupt.id)
        yield* ledger.onPassthrough({
          type: EventType.SUBAGENT_FINISHED,
          subagentRunId: open.callId,
          outcome: {
            type: "suspended",
            ...(interruptIds.length > 0 ? { interruptIds } : {}),
          },
        })
      } else {
        yield* ledger.onPassthrough({
          type: EventType.SUBAGENT_ERROR,
          subagentRunId: open.callId,
          message:
            reason.kind === "cancelled"
              ? "The run was cancelled."
              : "The run ended before the subagent finished.",
          code: reason.kind,
        })
      }
    }
    openSubagents.clear()
    return closed
  }

  /** The interrupt outcome, with each interrupt a suspended child raised attributed to it. */
  function* finishInterrupted(): Generator<AguiOutboundEvent> {
    yield* flushEveryOwner()
    const suspended = yield* closeOpenSubagents({
      kind: "interrupt",
      interrupts: pendingInterrupts,
    })
    yield* ledger.settle()
    yield {
      type: EventType.RUN_FINISHED,
      threadId: ctx.threadId,
      runId: ctx.runId,
      outcome: {
        type: "interrupt",
        interrupts: pendingInterrupts.map((interrupt) => {
          const run = interrupt.subagentRunId ?? interrupt.toolCallId
          return run !== undefined && suspended.has(run) && interrupt.subagentRunId === undefined
            ? { ...interrupt, subagentRunId: run }
            : interrupt
        }),
      },
      ...usage.terminal(),
    }
  }

  /**
   * The success outcome; a subagent still open here never got its `end`.
   * Async because the pending client-tool ids may come from the runtime's
   * tool-call record (an async read).
   */
  async function* finishSuccess(result: unknown): AsyncGenerator<AguiOutboundEvent> {
    yield* flushEveryOwner()
    yield* closeOpenSubagents({ kind: "unterminated" })
    yield* ledger.settle()
    yield {
      type: EventType.RUN_FINISHED,
      threadId: ctx.threadId,
      runId: ctx.runId,
      // 1.0: an absent result is omitted; null is not a result.
      ...(result !== undefined && result !== null ? { result } : {}),
      outcome: await successOutcome(),
      ...usage.terminal(),
    }
  }

  /** One owner's chunk, in the root chunk vocabulary. */
  function* handle(owner: Owner, chunk: B4AgentStreamChunk): Generator<AguiOutboundEvent> {
    const state = stateFor(owner)
    switch (chunk.type) {
      case "token": {
        const delta = typeof chunk.data === "string" ? chunk.data : ""
        if (delta.length === 0) break
        const sourceId =
          "messageId" in chunk && typeof chunk.messageId === "string" && chunk.messageId.length > 0
            ? chunk.messageId
            : undefined
        if (sourceId !== undefined) {
          yield* flushText(owner)
          state.anonymousParent = null
          let messageId = state.identifiedMessages.get(sourceId)
          if (messageId === undefined) {
            messageId = state.endedModelText.has(sourceId)
              ? nextId("message")
              : modelMessageId(state, sourceId)
            state.identifiedMessages.set(sourceId, messageId)
            yield* emit(owner, { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" })
          }
          yield* emit(owner, { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta })
          break
        }
        if (state.openMessageId === null) {
          state.openMessageId = nextId("message")
          state.anonymousParent = state.openMessageId
          yield* emit(owner, {
            type: EventType.TEXT_MESSAGE_START,
            messageId: state.openMessageId,
            role: "assistant",
          })
        }
        yield* emit(owner, {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: state.openMessageId,
          delta,
        })
        break
      }
      case "reasoning": {
        const delta = typeof chunk.data === "string" ? chunk.data : ""
        if (delta.length === 0) break
        const sourceId =
          "messageId" in chunk && typeof chunk.messageId === "string" && chunk.messageId.length > 0
            ? chunk.messageId
            : undefined
        if (sourceId !== undefined) {
          // An identified delta means the producer identifies invocations, so
          // anonymous reasoning belongs to nothing current. This invocation's
          // own text stays open: reasoning and text interleave until
          // `message_end`.
          yield* flushReasoning(owner)
          let open = state.identifiedReasoning.get(sourceId)
          if (open === undefined) {
            open = yield* openReasoningFrame(owner)
            state.identifiedReasoning.set(sourceId, open)
          }
          yield* emit(owner, {
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: open.messageId,
            delta,
          })
          break
        }
        if (state.openReasoning === null) state.openReasoning = yield* openReasoningFrame(owner)
        yield* emit(owner, {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: state.openReasoning.messageId,
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
          yield* closeIdentified(owner, data.messageId)
        }
        break
      }
      case "tool_call_args": {
        const fragment = asToolCallArgsData(chunk.data)
        if (!fragment) break
        const sent = state.openStreamedToolCalls.get(fragment.id)
        if (sent === undefined) {
          yield* flushText(owner)
          state.openStreamedToolCalls.set(fragment.id, "")
          yield* emit(owner, {
            type: EventType.TOOL_CALL_START,
            toolCallId: fragment.id,
            toolCallName: fragment.name,
            parentMessageId: modelMessageId(state, fragment.messageId),
          })
        }
        if (fragment.delta.length === 0) break
        state.openStreamedToolCalls.set(fragment.id, (sent ?? "") + fragment.delta)
        yield* emit(owner, {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: fragment.id,
          delta: fragment.delta,
        })
        break
      }
      case "tool_call": {
        yield* flushText(owner)
        const tc = asToolCallData(chunk.data)
        if (!tc) break
        const sent = tc.id === undefined ? undefined : state.openStreamedToolCalls.get(tc.id)
        if (tc.id !== undefined && sent !== undefined) {
          // The deltas already opened this call. The announce carries the
          // complete input, so anything the deltas did not cover goes out as
          // one last delta; the concatenation is then exactly the single
          // delta a non-streamed call carries. A payload that does not
          // extend the streamed text cannot be corrected, only ended.
          state.openStreamedToolCalls.delete(tc.id)
          const full = stringifyArgs(tc.input)
          if (full.length > sent.length && full.startsWith(sent)) {
            yield* emit(owner, {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: tc.id,
              delta: full.slice(sent.length),
            })
          }
          yield* emit(owner, { type: EventType.TOOL_CALL_END, toolCallId: tc.id })
          break
        }
        const toolCallId = tc.id ?? nextId("toolCall")
        if (tc.id === undefined) {
          const pending = state.pendingFallbackToolCallIds.get(tc.name)
          if (pending) {
            pending.push(toolCallId)
          } else {
            state.pendingFallbackToolCallIds.set(tc.name, [toolCallId])
          }
        }
        const frames: AguiOutboundEvent[] = [
          tag(owner, {
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: tc.name,
            parentMessageId: modelMessageId(state, tc.messageId),
          }),
          tag(owner, {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: stringifyArgs(tc.input),
          }),
          tag(owner, { type: EventType.TOOL_CALL_END, toolCallId }),
        ]
        if (owner === undefined) {
          yield* ledger.onToolCall(tc.id, tc.name, frames)
        } else {
          // Nothing of a child's is ever suppressed: its frames pass straight through.
          for (const frame of frames) yield* ledger.onPassthrough(frame)
        }
        break
      }
      case "tool_result": {
        yield* flushText(owner)
        // A result ends the model turn that announced the calls before it.
        state.anonymousParent = null
        const tr = asToolResultData(chunk.data)
        if (!tr) break
        const pending =
          tr.id === undefined ? state.pendingFallbackToolCallIds.get(tr.name) : undefined
        const toolCallId = tr.id ?? pending?.shift() ?? nextId("toolCall")
        if (pending?.length === 0) state.pendingFallbackToolCallIds.delete(tr.name)
        const view = toolResultView(tr.output)
        const resultEvent: ToolCallResultEvent = tag(owner, {
          type: EventType.TOOL_CALL_RESULT,
          messageId: nextId("toolResult"),
          toolCallId,
          content: toResultContent(tr.output, tr.id, view),
        })
        // A tool that threw: say so on the step, since the result's text alone
        // cannot tell an error from an answer. The step shares the result's
        // fate in the ledger (a suppressed result suppresses it too).
        const events: AguiOutboundEvent[] = [
          resultEvent,
          ...(view.failed ? [stepEvent(owner, { toolCallId, status: "failed" })] : []),
        ]
        if (owner === undefined) {
          yield* ledger.onToolResult(tr.id, tr.name, events)
        } else {
          for (const event of events) yield* ledger.onPassthrough(event)
        }
        break
      }
      case "step": {
        // No flushText, unlike `content_parts_dropped`: a step describes a call the text already yielded to.
        const step = asStepData(chunk.data)
        if (!step) break
        const event = stepEvent(owner, {
          toolCallId: step.tool_call_id,
          status: step.status,
          ...(step.icon !== undefined ? { icon: step.icon } : {}),
          ...(step.label !== undefined ? { label: step.label } : {}),
          ...(step.sources !== undefined ? { sources: step.sources } : {}),
        })
        // A root step shares its call's fate in the ledger; a child's never waits.
        yield* owner === undefined
          ? ledger.onToolStep(step.tool_call_id, event)
          : ledger.onPassthrough(event)
        break
      }
      case "plan_update": {
        const projection = activityProjector.project("plan_update", chunk.data, owner)
        if (projection.event === null) break
        if (owner === undefined) {
          yield* ledger.onActivity(projection.event, projection.orchestration)
        } else {
          yield* ledger.onPassthrough(projection.event)
        }
        break
      }
      case "content_parts_dropped": {
        // Root only: a child's `subagent.content_parts_dropped` takes the
        // default path below (its text is flushed, the chunk ignored).
        if (owner !== undefined) {
          yield* flushText(owner)
          break
        }
        // Not a protocol requirement: B4 frames text with START/CONTENT/END
        // (never CHUNK events), and the 1.0 client accepts a CUSTOM while a
        // message is open. Ending open text first is a tidiness choice, so
        // the drop notice lands between messages rather than inside one.
        yield* flushText(owner)
        yield* emit(owner, {
          type: EventType.CUSTOM,
          name: B4_CONTENT_PARTS_DROPPED_EVENT,
          value: chunk.data,
        })
        break
      }
      default:
        // Unknown extension chunks (e.g. capability.unknown) flush open text
        // and are ignored.
        yield* flushText(owner)
        break
    }
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
          yield* finishInterrupted()
          return
        }
        continue
      }

      switch (chunk.type) {
        case "usage":
        case "subagent.usage": {
          // A child's model call is part of this run's usage (the run is the
          // accounting boundary), so both spellings land in one collector.
          const data = asUsageData(chunk.data)
          if (data) usage.add(data)
          continue
        }
        case "subagent.start": {
          const start = asSubagentStartData(chunk.data)
          // A malformed announce, or one for an invocation already open, is a
          // malformed stream: dropped, never re-announced (the 1.0 verifier
          // would fail the run on a duplicate).
          if (start === null || openSubagents.has(start.callId)) continue
          openSubagents.set(start.callId, {
            callId: start.callId,
            parentCallId: start.parentCallId,
          })
          // The `subagentRunId` IS the `task` tool-call id: stable across an
          // interrupt → resume (the resumed run re-announces it, which 1.0
          // allows for a continued invocation), and the call it hangs off.
          yield* ledger.onPassthrough({
            type: EventType.SUBAGENT_STARTED,
            subagentRunId: start.callId,
            name: start.name,
            parentToolCallId: start.callId,
            ...(start.parentCallId !== undefined
              ? { parentSubagentRunId: start.parentCallId }
              : {}),
            ...(start.description !== undefined ? { description: start.description } : {}),
          })
          continue
        }
        case "subagent.end": {
          const end = asSubagentEndData(chunk.data)
          if (end === null || !openSubagents.has(end.callId)) continue
          yield* flushOwner(end.callId)
          openSubagents.delete(end.callId)
          if (end.error !== undefined) {
            yield* ledger.onPassthrough({
              type: EventType.SUBAGENT_ERROR,
              subagentRunId: end.callId,
              message: end.error,
            })
          } else {
            yield* ledger.onPassthrough({
              type: EventType.SUBAGENT_FINISHED,
              subagentRunId: end.callId,
              ...(end.result !== undefined ? { result: end.result } : {}),
              outcome: { type: "success" },
            })
          }
          continue
        }
        case "interrupt": {
          yield* flushEveryOwner()
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
          continue
        }
        case "done": {
          yield* finishSuccess(Object.hasOwn(chunk, "data") ? chunk.data : undefined)
          return
        }
        default:
          break
      }

      const unwrapped = unwrapSubagentChunk(chunk)
      if (unwrapped !== null) {
        // Announce before attribute (spec: subagents): a chunk for an
        // invocation this run never announced has no owner to carry it.
        if (!openSubagents.has(unwrapped.owner)) continue
        yield* handle(unwrapped.owner, unwrapped.chunk)
        continue
      }
      yield* handle(undefined, chunk)
    }
    // Stream ended without an explicit done/interrupt: flush and finish.
    if (pendingInterrupts.length > 0) {
      yield* finishInterrupted()
      return
    }
    yield* finishSuccess(undefined)
  } catch (err) {
    yield* flushEveryOwner()
    if (options.cancelled?.() === true) {
      yield* closeOpenSubagents({ kind: "cancelled" })
      yield* ledger.settle()
      yield {
        type: EventType.RUN_FINISHED,
        threadId: ctx.threadId,
        runId: ctx.runId,
        outcome: { type: "cancelled" },
        ...usage.terminal(),
      }
      return
    }
    // `RUN_ERROR` ends everything: open subagents are abandoned, not closed.
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
      ...usage.terminal(),
    }
  }
}
