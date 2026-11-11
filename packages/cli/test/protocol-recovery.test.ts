import { expect, it } from "vitest"
import { fixture } from "./fixtures/protocol-admission.ts"

it("assigns the canonical generation/sequence event ID inside the durable append", async () => {
  const f = await fixture()
  try {
    const accepted = await f.admit()
    const store = await f.store(accepted.threadId)
    const snapshot = await store.snapshot()
    const records = await store.transaction((tx) => tx.journal.read(0))
    expect(records.length).toBeGreaterThan(0)
    expect(records.map((record) => record.eventId)).toEqual(
      records.map((record) => `b4e1.${snapshot.scope.generation}.${record.seq}`),
    )
  } finally {
    await f.close()
  }
})

it("persists matching event envelope coordinates and trusted Run/turn correlation", async () => {
  const f = await fixture()
  try {
    const accepted = await f.admit()
    const store = await f.store(accepted.threadId)
    const snapshot = await store.snapshot()
    const records = await store.transaction((tx) => tx.journal.read(0))
    expect(records.length).toBeGreaterThan(0)
    const run = snapshot.runs.find((row) => row.run.run_id === accepted.runId)
    expect(run?.metadata).toMatchObject({
      v: 1,
      generation: snapshot.scope.generation,
      turnId: accepted.runId,
    })
    if (!run) throw new Error("Missing admitted Run in native storage")
    for (const record of records) {
      expect(record.ownerRunId).toBe(run.run.run_id)
      expect(record.event.eventId).toBe(record.eventId)
      expect(record.event.seq).toBe(record.seq)
      expect(record.event.b4).toEqual({
        v: 1,
        generation: run.metadata.generation,
        runId: run.run.run_id,
        turnId: run.metadata.turnId,
      })
    }
  } finally {
    await f.close()
  }
})
