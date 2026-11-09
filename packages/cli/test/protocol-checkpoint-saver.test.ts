import {
  type CheckpointListOptions,
  emptyCheckpoint,
  MemorySaver,
} from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it } from "vitest"
import {
  createRuntimeCheckpointSaver,
  createRuntimeNativeParkMinter,
  runtimeNativePermissionBinding,
  runtimePermissionResolver,
  verifyRuntimeNativePermission,
} from "../src/lib/runtime/checkpoint-saver.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.each(["singleton", "batch"] as const)(
  "binds the exact observed permission in native %s interrupt writes",
  async (representation) => {
    const f = await fixture()
    cleanup.push(() => f.close())
    const accepted = await f.admit(body({ on_completion: "keep" }))
    let failure: unknown
    const host = createExecutionHost({
      storage: f.storage,
      async invoke({ store, run }) {
        try {
          const saver = createRuntimeCheckpointSaver({
            store,
            runId: run.run.run_id,
            namespace: [],
          })
          const saved = await saver.put(
            {
              configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
            },
            emptyCheckpoint(),
            { source: "loop", step: 0, parents: {} },
            {},
          )
          const checkpointId = saved.configurable!.checkpoint_id as string
          const session = createRuntimeNativeParkMinter(store, saver, run.run.run_id, false)
          try {
            const request = { kind: "tool", detail: { tool: "selected" } }
            await runtimePermissionResolver(saver)({
              runId: run.run.run_id,
              checkpointId,
              checkpointNs: "tools:task-a",
              nativeTaskId: "task-a",
              interruptIndex: 1,
              request,
              protectedProposal: {},
              rule: { tool: "selected", pattern: "*" },
            })
            const selected = {
              id: "native-selected",
              value: { interruptId: "public-selected", ...request },
            }
            const unrelated = {
              id: "native-other",
              value: { interruptId: "public-other", kind: "other" },
            }
            const payload =
              representation === "batch"
                ? [
                    { id: "native-null", value: null },
                    { id: "native-array", value: ["opaque", 3] },
                    unrelated,
                    selected,
                  ]
                : selected
            await saver.putWrites(saved, [["__interrupt__", payload]], "task-a")
            expect((await saver.getTuple(saved))?.pendingWrites).toEqual([
              ["task-a", "__interrupt__", payload],
            ])
            const binding = await runtimeNativePermissionBinding(
              saver,
              checkpointId,
              "task-a",
              selected.id,
            )
            expect(binding).toMatchObject({
              checkpointId,
              taskId: "task-a",
              interruptId: selected.id,
              interruptIndex: 1,
              checkpointNs: "tools:task-a",
            })
            await store.transaction((tx) =>
              verifyRuntimeNativePermission(saver, tx, run.run.run_id, {
                namespace: [],
                interruptId: "public-selected",
                request,
                protectedProposal: {},
                nativeBinding: binding,
              }),
            )
            await expect(
              store.transaction((tx) =>
                verifyRuntimeNativePermission(saver, tx, run.run.run_id, {
                  namespace: [],
                  interruptId: "public-selected",
                  request,
                  protectedProposal: {},
                  nativeBinding: { ...binding, interruptIndex: 0 },
                }),
              ),
            ).rejects.toMatchObject({ code: "approval_changed" })
            await expect(
              runtimeNativePermissionBinding(saver, checkpointId, "task-a", "missing"),
            ).rejects.toMatchObject({ code: "approval_changed" })
            for (const value of [null, true, 17, "opaque", ["opaque", 3]]) {
              const opaque = { id: "native-opaque", value }
              await saver.putWrites(saved, [["__interrupt__", opaque]], "task-a")
              expect((await saver.getTuple(saved))?.pendingWrites).toEqual([
                ["task-a", "__interrupt__", opaque],
              ])
              await expect(
                runtimeNativePermissionBinding(saver, checkpointId, "task-a", opaque.id),
              ).rejects.toMatchObject({ code: "approval_changed" })
            }
            for (const invalid of [
              [],
              [selected, selected],
              [selected, []],
              [{ id: selected.id, value: null }],
              [{ id: selected.id, value: ["opaque"] }],
            ]) {
              await saver.putWrites(saved, [["__interrupt__", invalid]], "task-a")
              const before = await store.snapshot()
              await expect(
                runtimeNativePermissionBinding(saver, checkpointId, "task-a", selected.id),
              ).rejects.toMatchObject({ code: "approval_changed" })
              expect(await store.snapshot()).toEqual(before)
            }
          } finally {
            session.dispose()
          }
          return {}
        } catch (error) {
          failure = error
          throw error
        }
      },
    })
    cleanup.push(() => host.close())
    await host.tick()
    await host.idle()
    if (failure) throw failure
  },
  30_000,
)

it("restores actual native checkpoint versions and concurrent task writes from canonical storage", async () => {
  const f = await fixture()
  cleanup.push(() => f.close())
  const accepted = await f.admit(body({ on_completion: "keep" }))
  const host = createExecutionHost({
    storage: f.storage,
    async invoke({ store, run }) {
      const saver = createRuntimeCheckpointSaver({
        store,
        runId: run.run.run_id,
        namespace: [],
      })
      const checkpoint = emptyCheckpoint()
      checkpoint.channel_values = {
        messages: [{ role: "user", content: "durable" }],
      }
      checkpoint.channel_versions = { messages: 3 }
      checkpoint.versions_seen = { model: { messages: 2 } }
      const config = {
        configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
      }
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
      const restored = createRuntimeCheckpointSaver({
        store,
        runId: run.run.run_id,
        namespace: [],
      })
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
      const olderIdentity = {
        ...checkpoint,
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }
      const olderConfig = await saver.put(
        saved,
        olderIdentity,
        { source: "loop", step: 3, parents: {} },
        {},
      )
      const newHead = {
        ...checkpoint,
        id: "00000000-0000-4000-8000-000000000001",
      }
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

it("restores native writes by optional task path, code-point task identity and numeric index", async () => {
  const f = await fixture()
  cleanup.push(() => f.close())
  const accepted = await f.admit(body({ on_completion: "keep" }))
  let failure: unknown
  const host = createExecutionHost({
    storage: f.storage,
    async invoke({ store, run }) {
      try {
        const saver = createRuntimeCheckpointSaver({
          store,
          runId: run.run.run_id,
          namespace: [],
        })
        const config = {
          configurable: { thread_id: accepted.threadId, checkpoint_ns: "" },
        }
        const saved = await saver.put(
          config,
          emptyCheckpoint(),
          { source: "loop", step: 0, parents: {} },
          {},
        )
        const put = saver.putWrites.bind(saver) as (
          config: typeof saved,
          writes: [string, unknown][],
          taskId: string,
          taskPath?: string,
        ) => Promise<void>
        // Deliberately issue in the reverse of native replay order. Astral code
        // points must sort after BMP code points, rather than by UTF-16 units.
        const tasks = [
          ["astral-path", "\u{10000}"],
          ["bmp-path", "\ue000"],
          ["\u{10000}", "path"],
          ["\ue000", "path"],
          ["b", "same"],
          ["a", "same"],
          ["historical", undefined],
        ] as const
        for (const [task, path] of tasks)
          await put(
            saved,
            [
              ["first", task + "0"],
              ["second", task + "1"],
            ],
            task,
            path,
          )
        // Repeated positive writes retain their original identity/path and value.
        await put(saved, [["first", "must not overwrite"]], "a", "different-path")
        await put(saved, [["__error__", "a-error"]], "a", "same")
        // An older persisted checkpoint has no taskPath member at all.
        await store.transaction(async (tx) => {
          const row = await tx.checkpoints.get(saved.configurable!.checkpoint_id as string)
          if (!row) throw new Error("Missing native checkpoint")
          const payload = row.payload as { writes: Record<string, unknown>[] }
          await tx.checkpoints.put({
            ...row,
            payload: {
              ...payload,
              writes: payload.writes.map((write) => {
                if (write.taskId !== "historical") return write
                const { taskPath: _legacyAbsent, ...legacy } = write
                return legacy
              }),
            },
          })
        })
        const expected = [
          "historical",
          "\ue000",
          "\u{10000}",
          "a",
          "b",
          "bmp-path",
          "astral-path",
        ].flatMap((task) => [
          ...(task === "a" ? [[task, "__error__", "a-error"]] : []),
          [task, "first", task + "0"],
          [task, "second", task + "1"],
        ])
        const restored = createRuntimeCheckpointSaver({
          store,
          runId: run.run.run_id,
          namespace: [],
        })
        expect((await restored.getTuple(saved))?.pendingWrites).toEqual(expected)
        const listed = []
        for await (const tuple of restored.list(config)) listed.push(tuple)
        expect(listed[0]?.pendingWrites).toEqual(expected)
        return {}
      } catch (error) {
        failure = error
        throw error
      }
    },
  })
  cleanup.push(() => host.close())
  await host.tick()
  await host.idle()
  if (failure) throw failure
}, 30_000)

it("matches native MemorySaver list selectors and nonpositive limits across canonical history", async () => {
  const f = await fixture()
  cleanup.push(() => f.close())
  const accepted = await f.admit(body({ on_completion: "keep" }))
  let failure: unknown
  const host = createExecutionHost({
    storage: f.storage,
    async invoke({ store, run }) {
      try {
        const saver = createRuntimeCheckpointSaver({
          store,
          runId: run.run.run_id,
          namespace: [],
        })
        const reference = new MemorySaver()
        const config = { configurable: { thread_id: accepted.threadId, checkpoint_ns: "" } }
        const first = emptyCheckpoint(),
          second = emptyCheckpoint()
        expect(first.id < second.id).toBe(true)
        const metadata = [
          { source: "loop", step: 0, parents: {} },
          { source: "loop", step: 1, parents: {} },
        ] as const
        const savedFirst = await saver.put(config, first, metadata[0], {})
        await saver.put(savedFirst, second, metadata[1], {})
        const referenceFirst = await reference.put(config, first, metadata[0])
        await reference.put(referenceFirst, second, metadata[1])
        expect((await saver.getTuple(savedFirst))?.checkpoint.id).toBe(first.id)
        expect(
          (
            await saver.getTuple({
              configurable: { ...config.configurable, checkpoint_id: second.id },
            })
          )?.checkpoint.id,
        ).toBe(second.id)
        const scenarios: readonly {
          readonly name: string
          readonly checkpointId?: string
          readonly options?: CheckpointListOptions
        }[] = [
          { name: "unfiltered-descending" },
          {
            name: "before-second",
            options: { before: { configurable: { checkpoint_id: second.id } } },
          },
          { name: "limit-one", options: { limit: 1 } },
          { name: "metadata-first", options: { filter: { step: 0 } } },
          { name: "exact-first", checkpointId: first.id },
          { name: "exact-second", checkpointId: second.id },
          { name: "nonexistent", checkpointId: crypto.randomUUID() },
          { name: "limit-zero", options: { limit: 0 } },
          { name: "selected-limit-zero", checkpointId: second.id, options: { limit: 0 } },
          { name: "limit-negative", options: { limit: -1 } },
          { name: "selected-limit-negative", checkpointId: second.id, options: { limit: -1 } },
        ]
        const actual: Record<string, string[]> = {},
          expected: Record<string, string[]> = {}
        // Collect every selector/limit category before an aggregate oracle, so a
        // failure on one selection cannot hide unexecuted conformance cases.
        for (const scenario of scenarios) {
          const selected = {
            configurable: {
              ...config.configurable,
              ...(scenario.checkpointId !== undefined
                ? { checkpoint_id: scenario.checkpointId }
                : {}),
            },
          }
          actual[scenario.name] = []
          expected[scenario.name] = []
          for await (const tuple of saver.list(selected, scenario.options))
            actual[scenario.name]!.push(tuple.checkpoint.id)
          for await (const tuple of reference.list(selected, scenario.options))
            expected[scenario.name]!.push(tuple.checkpoint.id)
        }
        expect(expected["unfiltered-descending"]).toEqual([second.id, first.id])
        expect(expected["exact-first"]).toEqual([first.id])
        expect(expected["exact-second"]).toEqual([second.id])
        expect(expected.nonexistent).toEqual([])
        expect(expected["limit-zero"]).toEqual([])
        expect(expected["selected-limit-zero"]).toEqual([])
        expect(expected["limit-negative"]).toEqual([])
        expect(expected["selected-limit-negative"]).toEqual([])
        for (const control of [
          "unfiltered-descending",
          "before-second",
          "limit-one",
          "metadata-first",
        ])
          expect(actual[control]).toEqual(expected[control])
        for (const invalid of [
          { thread_id: "different-thread", checkpoint_ns: "" },
          { thread_id: accepted.threadId, checkpoint_ns: "different-namespace" },
        ])
          await expect(
            (async () => {
              for await (const _tuple of saver.list({ configurable: invalid }, { limit: 0 })) {
              }
            })(),
          ).rejects.toMatchObject({ code: "not_found" })
        expect(actual).toEqual(expected)
        return {}
      } catch (error) {
        failure = error
        throw error
      }
    },
  })
  cleanup.push(() => host.close())
  await host.tick()
  await host.idle()
  if (failure) throw failure
}, 30_000)
