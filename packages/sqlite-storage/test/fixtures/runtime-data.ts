import type {
  RuntimeCheckpointRecord,
  RuntimeReceiptRecord,
  RuntimeRunRecord,
  RuntimeThreadRecord,
} from "@b4run/sdk/agent-protocol"
export const scope = {
  threadId: "10000000-0000-4000-8000-000000000001",
  generation: "10000000-0000-4000-8000-000000000002",
  fence: 1,
}
export const runId = "10000000-0000-4000-8000-000000000003"
export const checkpointId = "10000000-0000-4000-8000-000000000004"
export const receiptId = "10000000-0000-4000-8000-000000000005"
export const eventId = "10000000-0000-4000-8000-000000000006"
export const now = "2026-11-06T00:00:00.000Z"
export const thread: RuntimeThreadRecord = {
  thread: {
    thread_id: scope.threadId,
    created_at: now,
    updated_at: now,
    status: "idle",
    metadata: {},
  },
  generation: scope.generation,
  revision: 1,
  headCheckpointId: checkpointId,
  currentRunId: runId,
  pausedGeneration: null,
  protectedMetadata: { lineage: "host-stamp" },
}
export const run: RuntimeRunRecord = {
  run: {
    run_id: runId,
    thread_id: scope.threadId,
    agent_id: "/test#agent",
    created_at: now,
    updated_at: now,
    status: "success",
    metadata: {},
  },
  metadata: {
    v: 1,
    generation: scope.generation,
    turnId: runId,
    phase: "settled",
    continuation: "closed",
    acceptedAt: now,
    effectsUncertain: false,
  },
  namespace: [],
  preRunCheckpointId: null,
  result: null,
}
export const checkpoint: RuntimeCheckpointRecord = {
  state: { checkpoint: { checkpoint_id: checkpointId }, values: { committed: true } },
  namespace: [],
  ownerRunId: runId,
  parentCheckpointId: null,
  payload: { adapter: "serialized" },
  masked: false,
  lineage: [
    {
      threadId: scope.threadId,
      generation: scope.generation,
      checkpointId,
      runId,
      namespace: [],
      protectedMetadata: { lineage: "host-stamp" },
    },
  ],
}
export const receipt: RuntimeReceiptRecord = {
  receiptId,
  fingerprint: "protected-fingerprint",
  state: "accepted",
  receipt: {
    submissionId: receiptId,
    submissionKind: "b4",
    runId,
    turnId: runId,
    acceptedAt: now,
    replayed: false,
    disposition: "accepted",
  },
}
