import type { Namespace } from "../agent-protocol/metadata.js"
import type { RuntimeJournalRecord, RuntimeRunRecord } from "../agent-protocol/storage.js"
import type { AspEvent } from "../agent-protocol/types.js"
import { asciiJsonV1, type RecoveryJsonValue } from "./runtime-recovery-json.js"

/** Current scoped native row plus its fetched payload. The backend must establish
 * this binding under its existing owner/fence lock; these fields are not a token. */
export interface RuntimeJournalStoredOwner {
  readonly runId: string
  readonly threadId: string
  readonly generation: string
  readonly turnId: string
  readonly record: RuntimeRunRecord
}
export interface RuntimeJournalAuthority {
  readonly threadId: string
  readonly generation: string
  readonly owner: RuntimeJournalStoredOwner | null
}

const preparedJournal = Symbol("prepared runtime journal append")
export interface RuntimePreparedJournalAppend {
  readonly [preparedJournal]: true
}
export interface RuntimeMaterializedJournalAppend {
  readonly record: RuntimeJournalRecord
  readonly namespaceJson: string
  readonly recordJson: string
}
interface PreparedState {
  readonly generation: string
  readonly ownerRunId: string | null
  readonly namespaceJson: string
  readonly eventJson: string
  readonly correlationJson: string
}
const preparedAppends = new WeakMap<RuntimePreparedJournalAppend, PreparedState>()
// Same UUID form as the wire schema, without RFC version/variant restrictions.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function canonicalId(value: unknown): value is string {
  // The fixed length also excludes a trailing newline before JavaScript's `$`.
  return typeof value === "string" && value.length === 36 && uuid.test(value)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid runtime journal append object")
  return value as Record<string, unknown>
}
function json(value: unknown): string {
  // The codec checks descriptors before serialization, rejecting getters,
  // executable values and unsupported JSON without invoking a toJSON hook.
  return asciiJsonV1(value as RecoveryJsonValue)
}
function detached(value: unknown): Record<string, unknown> {
  return object(JSON.parse(json(value)))
}
function namespace(value: unknown): value is string[] {
  // The codec already refused holes, extra array properties and prototypes.
  return Array.isArray(value) && value.every((part) => typeof part === "string")
}
function rejectStamps(value: Record<string, unknown>): void {
  if (["eventId", "seq", "b4"].some((key) => Object.hasOwn(value, key)))
    throw new Error("Caller supplied runtime journal coordinates")
}

/** Validate and detach before native sequence allocation. No namespace joining,
 * Unicode normalization or equality with the owning Run's root namespace. */
export function prepareRuntimeJournalAppend(
  input: unknown,
  authority: RuntimeJournalAuthority,
): RuntimePreparedJournalAppend {
  const draft = detached(input)
  const binding = detached(authority)
  rejectStamps(draft)
  const event = object(draft.event)
  rejectStamps(event)
  const params = object(event.params)
  const outerNamespace = draft.namespace
  const innerNamespace = params.namespace
  if (
    event.type !== "event" ||
    typeof event.method !== "string" ||
    !event.method.length ||
    !namespace(outerNamespace) ||
    !namespace(innerNamespace) ||
    outerNamespace.length !== innerNamespace.length ||
    outerNamespace.some((part, index) => part !== innerNamespace[index])
  )
    throw new Error("Invalid runtime journal event namespace")
  if (
    typeof binding.threadId !== "string" ||
    !binding.threadId.length ||
    !canonicalId(binding.generation)
  )
    throw new Error("Invalid runtime journal scope")

  let ownerRunId: string | null
  let correlation: Record<string, unknown>
  if (draft.ownerRunId === null) {
    if (binding.owner !== null) throw new Error("Conflicting runtime journal owner")
    ownerRunId = null
    correlation = { v: 1, generation: binding.generation }
  } else {
    const owner = object(binding.owner)
    const record = object(owner.record)
    const run = object(record.run)
    const metadata = object(record.metadata)
    if (
      !canonicalId(draft.ownerRunId) ||
      owner.runId !== draft.ownerRunId ||
      run.run_id !== draft.ownerRunId ||
      owner.threadId !== binding.threadId ||
      run.thread_id !== binding.threadId ||
      owner.generation !== binding.generation ||
      metadata.v !== 1 ||
      metadata.generation !== binding.generation ||
      !canonicalId(metadata.turnId) ||
      owner.turnId !== metadata.turnId
    )
      throw new Error("Conflicting runtime journal owner")
    ownerRunId = draft.ownerRunId
    correlation = {
      v: 1,
      generation: binding.generation,
      runId: ownerRunId,
      turnId: metadata.turnId,
    }
  }
  const prepared: RuntimePreparedJournalAppend = Object.freeze({ [preparedJournal]: true as const })
  preparedAppends.set(prepared, {
    generation: binding.generation,
    ownerRunId,
    namespaceJson: json(outerNamespace),
    eventJson: json(event),
    correlationJson: json(correlation),
  })
  return prepared
}

/** Stamp the safe native allocation and serialize once for the backend write.
 * Every materialization returns detached values; prepared state retains strings. */
export function materializeRuntimeJournalAppend(
  prepared: RuntimePreparedJournalAppend,
  seq: number,
): RuntimeMaterializedJournalAppend {
  const state = prepared && typeof prepared === "object" ? preparedAppends.get(prepared) : undefined
  if (!state || prepared[preparedJournal] !== true)
    throw new Error("Invalid prepared runtime journal append")
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Invalid runtime journal sequence")
  const eventId = `b4e1.${state.generation}.${seq}`
  const event = JSON.parse(state.eventJson) as AspEvent
  const record: RuntimeJournalRecord = {
    eventId,
    seq,
    namespace: JSON.parse(state.namespaceJson) as Namespace,
    ownerRunId: state.ownerRunId,
    event: { ...event, eventId, seq, b4: JSON.parse(state.correlationJson) },
  }
  return { record, namespaceJson: state.namespaceJson, recordJson: json(record) }
}
