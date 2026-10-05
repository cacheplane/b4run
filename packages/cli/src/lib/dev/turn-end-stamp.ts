import { B4_TURN_METADATA_KEY, type PersistedTurnEnd } from "@b4run/sdk"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import type { StreamChunk } from "../runtime/stream-types.js"

/**
 * The facts a handler holds when a run settles. `sawInterrupt` wins over the
 * other two: a turn that parked and then failed or was cancelled is still
 * parked, exactly as `terminalStatus` reads it.
 */
export interface TurnEndFacts {
  readonly sawInterrupt: boolean
  readonly cancelled: boolean
  readonly error?: string | undefined
}

/**
 * The turn-end record for the facts a handler has when a run settles, or
 * undefined for a park (the awaiting state is the parked interrupt itself,
 * and the turn resumes onto this same thread later).
 */
export function turnEndFor(
  facts: TurnEndFacts,
  now: () => string = () => new Date().toISOString(),
): PersistedTurnEnd | undefined {
  if (facts.sawInterrupt) return undefined
  if (facts.cancelled) return { status: "stopped", endedAt: now() }
  if (facts.error !== undefined && facts.error !== "") {
    return { status: "failed", error: facts.error, endedAt: now() }
  }
  return { status: "done", endedAt: now() }
}

/** The `error` string a terminal `done` chunk carries, if any. */
export function readTerminalError(chunk: StreamChunk | undefined): string | undefined {
  if (chunk === undefined || chunk.type !== "done") return undefined
  const output = (chunk as { readonly output?: unknown }).output
  if (typeof output !== "object" || output === null) return undefined
  const error = (output as { readonly error?: unknown }).error
  return typeof error === "string" ? error : undefined
}

/**
 * Write `b4:turn` onto the thread's head root checkpoint by re-putting it under
 * the same id and parent through the RAW saver (the provenance Proxy only wraps
 * runs, and the handlers hold the raw saver). Every saver upserts on
 * `(thread_id, checkpoint_ns, checkpoint_id)`, so this touches metadata only;
 * pending writes live in their own table and the parent comes from the config
 * passed in, which is the head's own `parentConfig`.
 *
 * Never throws: a failed stamp degrades the restored turn to "done without an
 * end time", never the run.
 */
export async function stampTurnEnd(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  end: PersistedTurnEnd,
): Promise<void> {
  try {
    const root = { configurable: { thread_id: threadId, checkpoint_ns: "" } }
    const head = await checkpointer.getTuple(root)
    if (!head) return
    await checkpointer.put(
      head.parentConfig ?? root,
      head.checkpoint,
      { ...head.metadata, [B4_TURN_METADATA_KEY]: end } as typeof head.metadata &
        Record<string, unknown>,
      head.checkpoint.channel_versions ?? {},
    )
  } catch (error) {
    console.warn(`B4: could not stamp the turn end on thread "${threadId}".`, error)
  }
}
