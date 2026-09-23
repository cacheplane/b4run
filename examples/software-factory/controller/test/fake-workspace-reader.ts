import type { WorkspaceReader } from "../src/lib/worker/workspace-reader.ts"

export interface FakeWorkspaceReader extends WorkspaceReader {
  /** Thread ids this reader was asked for, in order. */
  readonly reads: string[]
  /** Replace a thread's bytes between reads, to simulate drift. */
  set(threadId: string, files: Readonly<Record<string, string>>): void
  /** Remove a thread entirely, so a later read behaves like it was never scripted. */
  forget(threadId: string): void
  /**
   * Script successive reads of one thread: the first read serves `files[0]`, the next
   * `files[1]`, and the last entry sticks as the thread's bytes for every read after it. For
   * a drafter retried on the same thread, where the test cannot re-script between two reads
   * that follow one another inside a single tracked run.
   */
  queue(threadId: string, files: readonly Readonly<Record<string, string>>[]): void
}

/**
 * Scripted stand-in: the test chooses exactly what the builder (or the drafter) appears to
 * have written. It ignores the target's task id and any read root: a test scripts the keys
 * it wants back, `draft/`-prefixed for a drafter thread.
 */
export function createFakeWorkspaceReader(
  threads: Readonly<Record<string, Readonly<Record<string, string>>>>,
): FakeWorkspaceReader {
  const state = new Map(Object.entries(threads).map(([id, files]) => [id, { ...files }]))
  const reads: string[] = []
  const queues = new Map<string, Readonly<Record<string, string>>[]>()
  return {
    reads,
    set(threadId, files) {
      state.set(threadId, { ...files })
    },
    forget(threadId) {
      state.delete(threadId)
      queues.delete(threadId)
    },
    queue(threadId, files) {
      queues.set(threadId, [...files])
    },
    async read(target) {
      reads.push(target.threadId)
      const queued = queues.get(target.threadId)
      if (queued && queued.length > 0) {
        const next = queued.shift() as Readonly<Record<string, string>>
        if (queued.length === 0) queues.delete(target.threadId)
        state.set(target.threadId, { ...next })
      }
      const files = state.get(target.threadId)
      if (!files) throw new Error(`Fake workspace reader has no thread ${target.threadId}`)
      return new Map(Object.entries(files))
    },
  }
}
