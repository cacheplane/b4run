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
  const { scope } = access
  return {
    async append(input) {
      access.check()
      const ownerRunId = ownerIdentity(input)
      await access.reference("runs", ownerRunId)
      let owner: RuntimeJournalStoredOwner | null = null
      if (ownerRunId !== null) {
        const result = await access.query<{ payload: string; turn_id: string | null }>(
          "SELECT payload,turn_id FROM runs WHERE id=? AND thread_id=? AND generation=?",
          [ownerRunId, scope.threadId, scope.generation],
        )
        const native = result.rows[0]
        if (!native || typeof native.turn_id !== "string")
          throw new Error("Runtime journal owner requires a current Run and native turn")
        owner = {
          runId: ownerRunId,
          threadId: scope.threadId,
          generation: scope.generation,
          turnId: native.turn_id,
          record: JSON.parse(native.payload) as RuntimeRunRecord,
        }
      }
      const prepared = prepareRuntimeJournalAppend(input, {
        threadId: scope.threadId,
        generation: scope.generation,
        owner,
      })
      const current = await access.query<{ through_seq: string }>(
        "SELECT through_seq::text AS through_seq FROM scopes WHERE thread_id=? AND generation=?",
        [scope.threadId, scope.generation],
      )
      if (watermark(current.rows[0]?.through_seq) === Number.MAX_SAFE_INTEGER)
        throw diagnostic("capacity", "Runtime journal sequence exhausted")
      try {
        // The native increment serializes awaited concurrent appends. Do not
        // compare against the earlier read: another append may have advanced it.
        const result = await access.query<{ through_seq: string }>(
          "UPDATE scopes SET through_seq=through_seq+1 WHERE thread_id=? AND generation=? AND through_seq>=0 AND through_seq<9007199254740991 RETURNING through_seq::text AS through_seq",
          [scope.threadId, scope.generation],
        )
        const seq = watermark(result.rows[0]?.through_seq)
        const { record, namespaceJson, recordJson } = materializeRuntimeJournalAppend(prepared, seq)
        await access.query(
          "INSERT INTO journal(thread_id,generation,id,seq,owner_run_id,namespace,payload) VALUES (?,?,?,?,?,?,?)",
          [
            scope.threadId,
            scope.generation,
            record.eventId,
            seq,
            record.ownerRunId,
            namespaceJson,
            recordJson,
          ],
        )
        await access.query(
          "INSERT INTO projections AS current_projection(thread_id,generation,through_seq,revision,payload) VALUES (?,?,?,COALESCE((SELECT revision FROM threads WHERE thread_id=? AND generation=?),0),?) ON CONFLICT(thread_id,generation) DO UPDATE SET through_seq=excluded.through_seq,revision=excluded.revision,payload=excluded.payload WHERE current_projection.through_seq<=excluded.through_seq",
          [
            scope.threadId,
            scope.generation,
            seq,
            scope.threadId,
            scope.generation,
            JSON.stringify({ throughSeq: seq }),
          ],
        )
        return record
      } catch (error) {
        access.failJournal(error)
        throw error
      }
    },
    async read(afterSeq) {
      access.check()
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
        throw new Error("Invalid journal watermark")
      const result = await access.query<{ payload: string }>(
        "SELECT payload FROM journal WHERE thread_id=? AND generation=? AND seq>? ORDER BY seq",
        [scope.threadId, scope.generation, afterSeq],
      )
      return result.rows.map((row) => JSON.parse(row.payload) as RuntimeJournalRecord)
    },
  }
}
