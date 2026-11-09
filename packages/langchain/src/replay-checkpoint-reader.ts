import type { RunnableConfig } from "@langchain/core/runnables"
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint"

/** Internal per-stream hook that reads a dynamic child's checkpoint before it executes. */
export const REPLAY_CHECKPOINT_READER = "b4_replay_checkpoint_reader"

export type ChildReplayReader = (config: RunnableConfig) => Promise<CheckpointTuple | undefined>
export type ReplayCheckpointReader = (
  config: RunnableConfig,
  childReader?: ChildReplayReader,
) => Promise<void>

// Identity carries the already guarded child capability. Native configurable
// values and a runnable's shape never confer namespace authority.
const childReaders = new WeakMap<object, ChildReplayReader>()

/** Trusted runtime subpath only; one wrapper cannot change owner/reader epoch. */
export function bindRuntimeChildReplayReader(graph: object, reader: ChildReplayReader): void {
  if (childReaders.has(graph))
    throw Object.assign(new Error("A child replay reader is already bound to this graph"), {
      code: "not_supported",
    })
  childReaders.set(graph, reader)
}

export function childReplayReader(graph: object): ChildReplayReader | undefined {
  return childReaders.get(graph)
}
