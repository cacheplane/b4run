import { normalizeProviderMessage, type ProviderMessageProjection } from "@b4run/sdk"
import type { AgentStreamChunk } from "./agent-adapter.js"
import { type CanonicalJsonStream, createCanonicalJsonStream } from "./canonical-json-stream.js"

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : {}

interface CallStream {
  readonly args: CanonicalJsonStream
  raw: string
  ended: boolean
  result: boolean
  step: string
}

/** Native projection state scoped to one owner's single model invocation. */
export interface ProviderStreamState {
  provider: string | undefined
  message: RecordValue
  readonly ids: Set<string>
  readonly indices: Set<number>
  readonly calls: Map<string, CallStream>
  answer: ProviderMessageProjection["answer"]
}

/** Creates an isolated accumulator; callers discard it after the model ends. */
export function createProviderStreamState(): ProviderStreamState {
  return {
    provider: undefined,
    message: {},
    ids: new Set(),
    indices: new Set(),
    calls: new Map(),
    answer: undefined,
  }
}

function mergeOutputs(previous: unknown, next: unknown): unknown[] {
  const entries = new Map<string, RecordValue>()
  for (const value of [previous, next]) {
    for (const item of Array.isArray(value) ? value : value ? [value] : []) {
      const entry = record(item)
      const key = typeof entry.id === "string" ? entry.id : JSON.stringify(entry)
      entries.set(key, { ...entries.get(key), ...entry })
    }
  }
  return [...entries.values()]
}

/** Merges bridge fragments by transport ordinal, retaining repeated native parts. */
function mergeGoogleCandidates(previous: unknown, next: unknown): unknown[] {
  const entries: unknown[] = []
  const indices = new Map<number, number>()
  for (const item of [
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(next) ? next : []),
  ]) {
    const ordinal = record(item).ordinal
    const index = typeof ordinal === "number" ? indices.get(ordinal) : undefined
    if (index !== undefined) entries[index] = item
    else {
      if (typeof ordinal === "number") indices.set(ordinal, entries.length)
      entries.push(item)
    }
  }
  return entries
}

function mergeMetadata(previous: unknown, next: unknown): RecordValue {
  const old = record(previous)
  const update = record(next)
  return {
    ...old,
    ...update,
    ...(old.tool_outputs || update.tool_outputs
      ? { tool_outputs: mergeOutputs(old.tool_outputs, update.tool_outputs) }
      : {}),
    ...(old.b4_google_raw_candidates || update.b4_google_raw_candidates
      ? {
          b4_google_raw_candidates: mergeGoogleCandidates(
            old.b4_google_raw_candidates,
            update.b4_google_raw_candidates,
          ),
        }
      : {}),
  }
}

function isProgressOnly(message: RecordValue, id: string): boolean {
  const metadata = record(message.response_metadata)
  const additional = record(message.additional_kwargs)
  const entries = (value: unknown) =>
    (Array.isArray(value) ? value : value ? [value] : []).map(record)
  return (
    entries(metadata.tool_outputs).some((entry) => entry.id === id) &&
    ![...entries(additional.tool_outputs), ...entries(metadata.output)].some(
      (entry) => entry.id === id,
    )
  )
}

function nativeArgumentText(content: unknown, id: string): string | undefined {
  if (!Array.isArray(content)) return undefined
  const blocks = content.map(record)
  const ordinal = blocks.findIndex((block) => block.type === "server_tool_use" && block.id === id)
  const block = blocks[ordinal]
  if (!block) return undefined
  const deltas = blocks.filter(
    (entry) => entry.type === "input_json_delta" && entry.index === (block.index ?? ordinal),
  )
  if (deltas.length)
    return deltas
      .map((entry) =>
        typeof entry.partial_json === "string"
          ? entry.partial_json
          : typeof entry.input === "string"
            ? entry.input
            : "",
      )
      .join("")
  return typeof block.input === "string" && block.input ? block.input : undefined
}

/**
 * Accumulates native SDK-shaped progress and emits provider lifecycle frames.
 * The canonical message id creates derived identities; runId is only the live owner.
 */
export function projectProviderChunk(
  state: ProviderStreamState,
  value: unknown,
  runId: string,
  final = false,
  provider?: string,
): AgentStreamChunk[] {
  state.provider ??= provider
  const next = record(value)
  const previousContent = state.message.content
  const nextContent = next.content
  const content =
    final &&
    (Array.isArray(nextContent)
      ? nextContent.length > 0
      : typeof nextContent === "string" && nextContent.length > 0)
      ? nextContent
      : [
          ...(Array.isArray(previousContent) ? previousContent : []),
          ...(Array.isArray(nextContent) ? nextContent : []),
        ]
  state.message = {
    ...state.message,
    ...next,
    id: next.id ?? state.message.id,
    content,
    additional_kwargs: mergeMetadata(state.message.additional_kwargs, next.additional_kwargs),
    response_metadata: mergeMetadata(state.message.response_metadata, next.response_metadata),
  }
  for (const [ordinal, block] of (Array.isArray(content) ? content : []).entries()) {
    const entry = record(block)
    if (entry.type === "server_tool_use") {
      if (typeof entry.id === "string") state.ids.add(entry.id)
      state.indices.add(typeof entry.index === "number" ? entry.index : ordinal)
    }
  }
  const messageId = typeof state.message.id === "string" ? state.message.id : ""
  const projection = normalizeProviderMessage(state.message, {
    messageId,
    ...(state.provider ? { provider: state.provider } : {}),
  })
  state.answer = messageId ? projection.answer : undefined
  const chunks: AgentStreamChunk[] = []
  for (const call of projection.calls) {
    // A custom runnable may omit native identity; never derive an unstable id from runId.
    if (!messageId && call.id.startsWith(":code:")) continue
    state.ids.add(call.id)
    let current = state.calls.get(call.id)
    const step = { ...call.step, toolCallId: call.id }
    const emitStep = () => chunks.push({ type: "step", data: step })
    const signature = JSON.stringify(step)
    if (!current) {
      current = {
        args: createCanonicalJsonStream(),
        raw: "",
        ended: false,
        result: false,
        step: signature,
      }
      state.calls.set(call.id, current)
      emitStep()
      chunks.push({
        type: "tool_call_args",
        data: { id: call.id, name: call.name, delta: "", messageId: runId },
      })
    } else if (current.step !== signature) {
      current.step = signature
      emitStep()
    }
    const maySettle = final || !isProgressOnly(state.message, call.id)
    const hasResult = maySettle && call.result !== undefined
    const raw =
      nativeArgumentText(state.message.content, call.id) ??
      (typeof call.input === "string"
        ? call.input
        : final || hasResult
          ? JSON.stringify(call.input)
          : undefined)
    if (!current.ended && raw !== "{}" && raw?.startsWith(current.raw)) {
      const delta = current.args.push(raw.slice(current.raw.length))
      current.raw = raw
      if (delta)
        chunks.push({
          type: "tool_call_args",
          data: { id: call.id, name: call.name, delta, messageId: runId },
        })
    }
    if (!current.ended && (final || hasResult)) {
      const delta = current.args.flush()
      if (delta)
        chunks.push({
          type: "tool_call_args",
          data: { id: call.id, name: call.name, delta, messageId: runId },
        })
      emitStep()
      chunks.push({
        type: "tool_call",
        data: { id: call.id, name: call.name, input: call.input, messageId: runId },
      })
      current.ended = true
    }
    if (!current.result && hasResult) {
      emitStep()
      chunks.push({
        type: "tool_result",
        data: { id: call.id, name: call.name, output: call.result, step: call.step },
      })
      current.result = true
    }
  }
  return chunks
}

/** Removes only native identities and correlated native block indices from app fragments. */
export function ordinaryProviderChunk(state: ProviderStreamState, value: unknown): unknown {
  const chunk = record(value)
  if (!Array.isArray(chunk.tool_call_chunks)) return value
  return {
    ...chunk,
    tool_call_chunks: chunk.tool_call_chunks.filter((value) => {
      const fragment = record(value)
      if (typeof fragment.id === "string" && state.ids.has(fragment.id)) {
        if (typeof fragment.index === "number") state.indices.add(fragment.index)
        return false
      }
      return typeof fragment.index !== "number" || !state.indices.has(fragment.index)
    }),
  }
}
