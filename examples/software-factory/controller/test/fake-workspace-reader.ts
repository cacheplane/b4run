import type { WorkspaceReader } from "../src/lib/worker/workspace-reader.ts"

export interface FakeWorkspaceReader extends WorkspaceReader {
  /** Thread ids this reader was asked for, in order. */
  readonly reads: string[]
  /** Replace a thread's bytes between reads, to simulate drift. */
  set(threadId: string, files: Readonly<Record<string, string>>): void
  /** Remove a thread entirely, so a later read behaves like it was never scripted. */
  forget(threadId: string): void
}

/** Scripted stand-in: the test chooses exactly what the builder appears to have written. */
export function createFakeWorkspaceReader(
  threads: Readonly<Record<string, Readonly<Record<string, string>>>>,
): FakeWorkspaceReader {
  const state = new Map(Object.entries(threads).map(([id, files]) => [id, { ...files }]))
  const reads: string[] = []
  return {
    reads,
    set(threadId, files) {
      state.set(threadId, { ...files })
    },
    forget(threadId) {
      state.delete(threadId)
    },
    async read(target) {
      reads.push(target.threadId)
      const files = state.get(target.threadId)
      if (!files) throw new Error(`Fake workspace reader has no thread ${target.threadId}`)
      return new Map(Object.entries(files))
    },
  }
}
