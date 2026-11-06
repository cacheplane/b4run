import type { RuntimeRunRecord, RuntimeThreadRecord } from "@b4run/sdk/agent-protocol"
import { ids, now, scope } from "./runtime-backend.ts"
export const run: RuntimeRunRecord = {
  run: {
    run_id: ids.predecessor,
    thread_id: ids.thread,
    agent_id: "/test#agent",
    created_at: now(),
    updated_at: now(),
    status: "pending",
    metadata: {},
  },
  metadata: {
    v: 1,
    generation: ids.generation,
    turnId: ids.predecessor,
    phase: "accepted",
    continuation: "none",
    acceptedAt: now(),
    effectsUncertain: false,
  },
  namespace: [],
  preRunCheckpointId: null,
  result: null,
}
export const thread: RuntimeThreadRecord = {
  thread: {
    thread_id: ids.thread,
    created_at: now(),
    updated_at: now(),
    metadata: {},
    status: "idle",
  },
  generation: scope.generation,
  revision: 1,
  headCheckpointId: null,
  currentRunId: ids.predecessor,
  pausedGeneration: null,
  protectedMetadata: {},
}
