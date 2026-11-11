import type { RuntimeJournalRecord } from "@b4run/sdk/agent-protocol"
import { expect, it } from "vitest"
import { fixture } from "./fixtures/protocol-admission.ts"

it("keeps global durable replay coordinates and distinct namespace component arrays", async () => {
  const f = await fixture()
  try {
    const accepted = await f.admit()
    const store = await f.store(accepted.threadId)
    const snapshot = await store.snapshot()
    const namespaces = [["child/a"], [], ["child", "a"]] as const
    const appended = await store.transaction(async (tx) => {
      const records: RuntimeJournalRecord[] = []
      for (const namespace of namespaces) {
        records.push(
          await tx.journal.append({
            ownerRunId: null,
            namespace,
            event: {
              type: "event",
              method: "values",
              params: { namespace, timestamp: 1793880000000, data: { visible: true } },
            },
          }),
        )
      }
      return records
    })
    const first = appended[0]
    if (!first) throw new Error("Missing first durable namespace fact")
    const replay = await store.transaction((tx) => tx.journal.read(first.seq))
    expect(replay.map((record) => record.seq)).toEqual([first.seq + 1, first.seq + 2])
    expect(appended.map((record) => record.namespace)).toEqual(namespaces)
    expect(replay.map((record) => record.namespace)).toEqual([[], ["child", "a"]])
    for (const record of replay) {
      expect(record.ownerRunId).toBeNull()
      expect(record.eventId).toBe(`b4e1.${snapshot.scope.generation}.${record.seq}`)
      expect(record.event.eventId).toBe(record.eventId)
      expect(record.event.seq).toBe(record.seq)
      expect(record.event.params.namespace).toEqual(record.namespace)
      expect(record.event.b4).toEqual({ v: 1, generation: snapshot.scope.generation })
    }
  } finally {
    await f.close()
  }
})
