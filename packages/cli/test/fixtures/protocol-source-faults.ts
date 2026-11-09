import type { RuntimeStoppedSourceProof, RuntimeStore } from "@b4run/sdk/agent-protocol"
import { expect } from "vitest"
import { body, type fixture } from "./protocol-admission.ts"

/** Fault only the owned real checkpoint; each refused acceptance must roll back. */
export async function rejectStoppedSourceFaults(
  f: Awaited<ReturnType<typeof fixture>>,
  threadId: string,
  store: RuntimeStore,
) {
  const before = await store.snapshot(),
    head = before.checkpoints.find(
      (row) => row.state.checkpoint.checkpoint_id === before.thread?.headCheckpointId,
    )!
  type Payload = {
    reboundFrom: { checkpointOwnerRunId: string; stoppedSource: RuntimeStoppedSourceProof }
  }
  const mutations: ((payload: Payload) => void)[] = [
    (payload) => {
      ;(payload.reboundFrom.stoppedSource.path[0] as { receiptId: string }).receiptId = "0".repeat(
        64,
      )
    },
    (payload) => {
      ;(payload.reboundFrom.stoppedSource.path[0] as { selectedHead: string }).selectedHead =
        head.state.checkpoint.checkpoint_id
    },
    (payload) => {
      payload.reboundFrom.checkpointOwnerRunId = crypto.randomUUID()
    },
    (payload) => {
      ;(payload.reboundFrom.stoppedSource.path[0] as { runId: string }).runId = crypto.randomUUID()
    },
    (payload) => {
      ;(payload.reboundFrom.stoppedSource.path as RuntimeStoppedSourceProof["path"][number][]).push(
        payload.reboundFrom.stoppedSource.path[0]!,
      )
    },
  ]
  const witness = (head.payload as Payload).reboundFrom.stoppedSource
  if (!witness) {
    // Cooperative drain can checkpoint the current continuation's own head.
    // No cross-owner witness is needed, but its exact source identities remain
    // mandatory and are frozen into the next admission's protected source.
    type OwnHead = {
      safeHead: boolean
      reboundFrom: {
        runId: string
        checkpointId: string
        checkpointOwnerRunId: string
      }
    }
    const original = head.payload as OwnHead
    expect(original.reboundFrom.checkpointOwnerRunId).toBe(original.reboundFrom.runId)
    const faults: { edit(payload: OwnHead): void; code: string }[] = [
      {
        edit: (payload) => {
          payload.reboundFrom.runId = crypto.randomUUID()
        },
        code: "not_supported",
      },
      {
        edit: (payload) => {
          payload.reboundFrom.checkpointId = crypto.randomUUID()
        },
        code: "scope_mismatch",
      },
      {
        edit: (payload) => {
          payload.reboundFrom.checkpointOwnerRunId = crypto.randomUUID()
        },
        code: "scope_mismatch",
      },
      {
        edit: (payload) => {
          payload.safeHead = false
        },
        code: "not_supported",
      },
    ]
    const sources = await store.transaction((tx) => tx.protectedSources.list())
    for (const fault of faults) {
      const payload = structuredClone(original)
      fault.edit(payload)
      try {
        await store.transaction((tx) => tx.checkpoints.put({ ...head, payload }))
        const faulted = await store.snapshot()
        await expect(
          f.admit(
            body({
              thread_id: threadId,
              on_completion: "keep",
              metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
            }),
          ),
        ).rejects.toMatchObject({ code: fault.code })
        expect(await store.snapshot()).toEqual(faulted)
        expect(await store.transaction((tx) => tx.protectedSources.list())).toEqual(sources)
      } finally {
        await store.transaction((tx) => tx.checkpoints.put(head))
      }
    }
    expect(await store.snapshot()).toEqual(before)
    return
  }
  if (witness.kind !== "accepted_not_started") {
    type MutableWitness = {
      execution: { ownerId: string; fence: number }
      startedAt: string
      unwoundAt?: string
      ownershipLoss?: {
        ownerId: string
        fence: number
        detectedAt: string
        effectsUncertain: boolean
      }
      kind: string
    }
    const edit = (payload: Payload) =>
      payload.reboundFrom.stoppedSource as unknown as MutableWitness
    mutations.push(
      (payload) => {
        edit(payload).execution.ownerId = "forged-owner"
      },
      (payload) => {
        edit(payload).execution.fence++
      },
      (payload) => {
        edit(payload).startedAt = "2000-01-01T00:00:00.000Z"
      },
      (payload) => {
        edit(payload).kind = "accepted_not_started"
      },
    )
    if (witness.kind === "started_unwound")
      mutations.push((payload) => {
        edit(payload).unwoundAt = "2000-01-01T00:00:00.000Z"
      })
    else
      mutations.push(
        (payload) => {
          edit(payload).ownershipLoss!.ownerId = "forged-lost-owner"
        },
        (payload) => {
          edit(payload).ownershipLoss!.fence++
        },
        (payload) => {
          edit(payload).ownershipLoss!.detectedAt = "2000-01-01T00:00:00.000Z"
        },
        (payload) => {
          edit(payload).ownershipLoss!.effectsUncertain = false
        },
      )
  }
  const sources = await store.transaction((tx) => tx.protectedSources.list())
  for (const mutate of mutations) {
    const payload = structuredClone(head.payload) as Payload
    mutate(payload)
    try {
      await store.transaction((tx) => tx.checkpoints.put({ ...head, payload }))
      const faulted = await store.snapshot()
      await expect(
        f.admit(
          body({
            thread_id: threadId,
            metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
            on_completion: "keep",
          }),
        ),
      ).rejects.toMatchObject({ code: "scope_mismatch" })
      expect(await store.snapshot()).toEqual(faulted)
      expect(await store.transaction((tx) => tx.protectedSources.list())).toEqual(sources)
    } finally {
      await store.transaction((tx) => tx.checkpoints.put(head))
    }
  }
  if (witness.kind !== "accepted_not_started") {
    const origin = before.checkpoints.find(
      (row) => row.state.checkpoint.checkpoint_id === witness.path[0]!.selectedHead,
    )!
    type Write = {
      kind?: string
      ownerRunId: string
      fence: number
      channel: string
      taskId: string
      namespaceGeneration: string
      sourceCheckpointId: string | null
    }
    const changes: ((write: Write) => void)[] = [
      (write) => {
        delete write.kind
      },
      (write) => {
        write.kind = "forged"
      },
      (write) => {
        write.kind = "administrative"
      },
      (write) => {
        write.ownerRunId = crypto.randomUUID()
      },
      (write) => {
        write.fence++
      },
      (write) => {
        write.namespaceGeneration = crypto.randomUUID()
      },
      (write) => {
        write.sourceCheckpointId = crypto.randomUUID()
      },
    ]
    for (const change of changes) {
      const payload = structuredClone(origin.payload) as { writes: Write[] }
      const write = payload.writes.find(
        (row) =>
          row.kind === "execution" &&
          row.ownerRunId === witness.path[0]!.runId &&
          row.channel === "__resume__",
      )!
      expect(write).toBeDefined()
      change(write)
      try {
        await store.transaction((tx) => tx.checkpoints.put({ ...origin, payload }))
        const faulted = await store.snapshot()
        await expect(
          f.admit(
            body({
              thread_id: threadId,
              metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
              on_completion: "keep",
            }),
          ),
        ).rejects.toMatchObject({ code: "scope_mismatch" })
        expect(await store.snapshot()).toEqual(faulted)
      } finally {
        await store.transaction((tx) => tx.checkpoints.put(origin))
      }
    }
  }
  expect(await store.snapshot()).toEqual(before)
}
