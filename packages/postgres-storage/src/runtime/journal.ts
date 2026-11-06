import type { RuntimeJournalRecord, RuntimeTransaction } from "@b4run/sdk/agent-protocol"
import { type Access, diagnostic } from "./transaction.js"
export function makeJournal(access: Access): RuntimeTransaction["journal"] {
  const { scope } = access
  return {
    async append(row) {
      await access.reference("journal", row.eventId)
      await access.reference("runs", row.ownerRunId)
      const result = await access.query<{ through_seq: string }>(
        "UPDATE scopes SET through_seq=through_seq+1 WHERE thread_id=? AND generation=? AND through_seq<9007199254740991 RETURNING through_seq",
        [scope.threadId, scope.generation],
      )
      const seq = Number(result.rows[0]?.through_seq)
      if (!Number.isSafeInteger(seq))
        throw diagnostic("capacity", "Runtime journal sequence exhausted")
      const record = { ...row, seq }
      await access.query(
        "INSERT INTO journal(thread_id,generation,id,seq,owner_run_id,namespace,payload) VALUES (?,?,?,?,?,?,?)",
        [
          scope.threadId,
          scope.generation,
          row.eventId,
          seq,
          row.ownerRunId,
          JSON.stringify(row.namespace),
          JSON.stringify(record),
        ],
      )
      await access.query(
        "INSERT INTO projections(thread_id,generation,through_seq,revision,payload) VALUES (?,?,?,COALESCE((SELECT revision FROM threads WHERE thread_id=? AND generation=?),0),?) ON CONFLICT(thread_id,generation) DO UPDATE SET through_seq=excluded.through_seq,revision=excluded.revision,payload=excluded.payload",
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
