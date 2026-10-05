import type { ThreadStateForTurns } from "@b4run/ag-ui/view"
import { canListNamespaces } from "@b4run/core"
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { grantOf, readPendingInterrupts, withoutClientToolParks } from "./pending-interrupts.js"

/**
 * Decoded checkpoints `loadThreadStateForTurns` reads across every namespace
 * before it stops and reports `truncated` (spec §4). The root namespace is
 * read first and newest-first, so a thread over the cap still answers with
 * its newest turns.
 */
export const TURNS_CHECKPOINT_CAP = 2000

/**
 * The envelope shape `/state` clients already read: `JSON.stringify` calls
 * each LangChain message's `toJSON`, which yields `{ lc, type, id, kwargs }`;
 * `turnsFromState` reads exactly that and never a class instance.
 */
const toPlain = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T

async function history(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  ns: string,
  budget: { left: number },
): Promise<ThreadStateForTurns["root"]> {
  const tuples: CheckpointTuple[] = []
  if (budget.left > 0) {
    for await (const tuple of checkpointer.list(
      { configurable: { thread_id: threadId, checkpoint_ns: ns } },
      { limit: budget.left },
    )) {
      budget.left -= 1
      tuples.push(tuple)
      if (budget.left <= 0) break
    }
  }
  // list() is newest first; the synthesiser wants oldest first.
  tuples.reverse()
  return tuples.map((tuple) => ({
    id: tuple.checkpoint.id,
    ts: tuple.checkpoint.ts,
    metadata: toPlain(tuple.metadata ?? null),
    values: toPlain({
      messages: tuple.checkpoint.channel_values?.messages,
      todos: tuple.checkpoint.channel_values?.todos,
    }),
  }))
}

/**
 * Everything `turnsFromState` needs for one thread, read in one pass: the root
 * and child histories (oldest first, decoded once by the checkpointer's own
 * deserializer and serialized to plain JSON), the parked interrupts off the
 * head in the shape `/pending_interrupts` serves, and the thread status.
 * `truncated` when the cap stopped decoding before the stores were exhausted.
 *
 * A checkpointer without `listNamespaces` (LangGraph's `MemorySaver`) yields
 * no children: every `task` call then restores with a "no checkpoints for
 * child namespace" warning rather than failing the whole read.
 */
export async function loadThreadStateForTurns(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  status: ThreadStateForTurns["status"],
): Promise<{ state: ThreadStateForTurns; truncated: boolean }> {
  const budget = { left: TURNS_CHECKPOINT_CAP }
  const root = await history(checkpointer, threadId, "", budget)
  const children: Record<string, ThreadStateForTurns["root"]> = {}
  let truncated = false
  if (canListNamespaces(checkpointer)) {
    for (const ns of await checkpointer.listNamespaces(threadId)) {
      if (ns === "") continue
      if (budget.left <= 0) {
        truncated = true
        break
      }
      children[ns] = await history(checkpointer, threadId, ns, budget)
    }
  }
  const pendingSnapshot = await readPendingInterrupts(checkpointer, threadId)
  const snapshot = pendingSnapshot ? withoutClientToolParks(pendingSnapshot) : null
  const pendingInterrupts = (snapshot?.interrupts ?? []).map(({ interruptId, value }) => {
    const grant = grantOf(value)
    return {
      interruptId,
      value: toPlain(value),
      ...(grant !== undefined ? { grant } : {}),
    }
  })
  // A budget run to zero is reported as truncated even when the stores held
  // exactly the cap: a false `truncated: true` costs a client one needless
  // "older turns omitted" note, a false `false` would hide a cut history.
  if (budget.left <= 0) truncated = true
  return { state: { threadId, status, root, children, pendingInterrupts }, truncated }
}
