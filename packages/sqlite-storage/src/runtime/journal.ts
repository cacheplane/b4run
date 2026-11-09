import type { RuntimeJournalRecord, RuntimeTransaction } from "@b4run/sdk/agent-protocol"
import { type Access, diagnostic } from "./transaction.js"
export function makeJournal(access: Access): RuntimeTransaction["journal"] {
  const { db, scope } = access
  return {
    async append(row) {
      access.check()
      access.reference("journal", row.eventId)
      access.reference("runs", row.ownerRunId)
      const current = Number(
        db
          .prepare("SELECT through_seq FROM scopes WHERE thread_id=? AND generation=?")
          .get(scope.threadId, scope.generation)?.through_seq,
      )
      if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER)
        throw diagnostic("capacity", "Runtime journal sequence exhausted")
      const record = { ...row, seq: current + 1 }
      db.prepare("INSERT INTO journal VALUES (?,?,?,?,?,?,?)").run(
        scope.threadId,
        scope.generation,
        row.eventId,
        record.seq,
        row.ownerRunId,
        JSON.stringify(row.namespace),
        JSON.stringify(record),
      )
      db.prepare("UPDATE scopes SET through_seq=? WHERE thread_id=? AND generation=?").run(
        record.seq,
        scope.threadId,
        scope.generation,
      )
      // Store the committed journal cut separately from transport publication.
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
