import { emptyCheckpoint } from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it } from "vitest"
import { createRuntimeCheckpointSaver } from "../src/lib/runtime/checkpoint-saver.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("restores actual native checkpoint versions and concurrent task writes from canonical storage", async () => {
  const f = await fixture()
  cleanup.push(() => f.close())
  const accepted = await f.admit(body({ on_completion: "keep" }))
  const host = createExecutionHost({
    storage: f.storage,
    async invoke({ store, run }) {
      const saver = createRuntimeCheckpointSaver({ store, runId: run.run.run_id, namespace: [] })
      const checkpoint = emptyCheckpoint()
      checkpoint.channel_values = { messages: [{ role: "user", content: "durable" }] }
      checkpoint.channel_versions = { messages: 3 }
      checkpoint.versions_seen = { model: { messages: 2 } }
      const config = { configurable: { thread_id: accepted.threadId, checkpoint_ns: "" } }
      const saved = await saver.put(
        config,
        checkpoint,
        { source: "loop", step: 2, parents: {} },
        { messages: 3 },
      )
      await Promise.all([
        saver.putWrites(saved, [["messages", "first"]], "task-a"),
        saver.putWrites(saved, [["messages", "second"]], "task-b"),
        saver.putWrites(saved, [["messages", "first"]], "task-a"),
      ])
      const restored = createRuntimeCheckpointSaver({ store, runId: run.run.run_id, namespace: [] })
      const tuple = await restored.getTuple(saved)
      expect(tuple?.checkpoint).toEqual(checkpoint)
      expect(tuple?.pendingWrites).toEqual(
        expect.arrayContaining([
          ["task-a", "messages", "first"],
          ["task-b", "messages", "second"],
        ]),
      )
      expect(tuple?.pendingWrites).toHaveLength(2)
      const snapshot = await store.snapshot()
      expect(snapshot.thread?.headCheckpointId).toBe(checkpoint.id)
      expect(snapshot.checkpoints[0]?.state.checkpoint.checkpoint_id).toBe(checkpoint.id)
      const olderIdentity = { ...checkpoint, id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }
      const olderConfig = await saver.put(
        saved,
        olderIdentity,
        { source: "loop", step: 3, parents: {} },
        {},
      )
      const newHead = { ...checkpoint, id: "00000000-0000-4000-8000-000000000001" }
      await saver.put(olderConfig, newHead, { source: "loop", step: 4, parents: {} }, {})
      expect((await saver.getTuple(config))?.checkpoint.id).toBe(newHead.id)
      return {}
    },
  })
  cleanup.push(() => host.close())
  await host.tick()
  await host.idle()
  expect((await f.snapshot(accepted.threadId)).runs[0]?.run.status).toBe("success")
}, 30_000)
