import type {
  RuntimeJournalRecord,
  RuntimeRunRecord,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
import {
  materializeRuntimeJournalAppend,
  prepareRuntimeJournalAppend,
  type RuntimeJournalStoredOwner,
} from "@b4run/sdk/internal/runtime-identity"
import { type Access, diagnostic } from "./transaction.js"

// Read no caller accessor and bind no arbitrary value into the native driver.
function ownerIdentity(input: unknown): string | null {
  const descriptor =
    input && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "ownerRunId")
      : undefined
  if (
    !descriptor ||
    !("value" in descriptor) ||
    (descriptor.value !== null && (typeof descriptor.value !== "string" || !descriptor.value))
  )
    throw new Error("Invalid runtime journal owner")
  return descriptor.value as string | null
}
function watermark(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw diagnostic("capacity", "Invalid runtime journal sequence")
  const integer = BigInt(value)
  if (integer.toString() !== value || integer > BigInt(Number.MAX_SAFE_INTEGER))
    throw diagnostic("capacity", "Invalid runtime journal sequence")
  return Number(integer)
}
export function makeJournal(access: Access): RuntimeTransaction["journal"] {
  const { db, scope } = access
  return {
    async append(input) {
      access.check()
      const ownerRunId = ownerIdentity(input)
      access.reference("runs", ownerRunId)
      let owner: RuntimeJournalStoredOwner | null = null
      if (ownerRunId !== null) {
        const native = db
          .prepare("SELECT payload,turn_id FROM runs WHERE id=? AND thread_id=? AND generation=?")
          .get(ownerRunId, scope.threadId, scope.generation)
        if (!native || typeof native.turn_id !== "string")
          throw new Error("Runtime journal owner requires a current Run and native turn")
        owner = {
          runId: ownerRunId,
          threadId: scope.threadId,
          generation: scope.generation,
          turnId: native.turn_id,
          record: JSON.parse(String(native.payload)) as RuntimeRunRecord,
        }
      }
      const prepared = prepareRuntimeJournalAppend(input, {
        threadId: scope.threadId,
        generation: scope.generation,
        owner,
      })
      const current = db
        .prepare(
          "SELECT CAST(through_seq AS TEXT) AS through_seq,typeof(through_seq) AS native_type FROM scopes WHERE thread_id=? AND generation=?",
        )
        .get(scope.threadId, scope.generation)
      if (current?.native_type !== "integer")
        throw diagnostic("capacity", "Invalid runtime journal sequence")
      const throughSeq = watermark(current.through_seq)
      if (throughSeq === Number.MAX_SAFE_INTEGER)
        throw diagnostic("capacity", "Runtime journal sequence exhausted")
      try {
        const { record, namespaceJson, recordJson } = materializeRuntimeJournalAppend(
          prepared,
          throughSeq + 1,
        )
        db.prepare("INSERT INTO journal VALUES (?,?,?,?,?,?,?)").run(
          scope.threadId,
          scope.generation,
          record.eventId,
          record.seq,
          record.ownerRunId,
          namespaceJson,
          recordJson,
        )
        db.prepare("UPDATE scopes SET through_seq=? WHERE thread_id=? AND generation=?").run(
          record.seq,
          scope.threadId,
          scope.generation,
        )
        // A placeholder cut, distinct from a finalized reducer projection.
        db.prepare(
          "INSERT INTO projections VALUES (?,?,?,COALESCE((SELECT revision FROM threads WHERE thread_id=? AND generation=?),0),?) ON CONFLICT(thread_id,generation) DO UPDATE SET through_seq=excluded.through_seq,revision=excluded.revision,payload=excluded.payload",
        ).run(
          scope.threadId,
          scope.generation,
          record.seq,
          scope.threadId,
          scope.generation,
          JSON.stringify({ throughSeq: record.seq }),
        )
        return record
      } catch (error) {
        // A caught append failure must never allow partial facts to commit.
        access.failJournal(error)
        throw error
      }
    },
    async read(afterSeq) {
      access.check()
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
        throw new Error("Invalid journal watermark")
      return db
        .prepare(
          "SELECT payload FROM journal WHERE thread_id=? AND generation=? AND seq>? ORDER BY seq",
        )
        .all(scope.threadId, scope.generation, afterSeq)
        .map((row) => JSON.parse(String(row.payload)) as RuntimeJournalRecord)
    },
  }
}
