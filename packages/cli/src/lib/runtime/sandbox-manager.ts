import type { SandboxHandle, SandboxPolicy, SandboxProvider } from "@b4run/workspace"
import type { AdmittedWorkspace, ManagedWorkspaceManager } from "./managed-workspace-manager.js"

interface Entry {
  handle?: SandboxHandle
  acquiring?: Promise<SandboxHandle>
  lastUsedAt: number
  inUse: number
}

/**
 * Owns the per-thread sandbox lifecycle. One instance per server process.
 * - getForThread: create-or-reuse the thread's handle (concurrent acquires deduped).
 * - reapIdle: release() warm compute for threads idle past idleTimeoutMs (volume kept).
 * - destroyThread: full teardown (volume removed) — thread delete.
 * - releaseAll: shutdown — release() everything (volume kept).
 */
export class SandboxManager {
  readonly #provider: SandboxProvider
  readonly #policy: SandboxPolicy
  readonly #idleTimeoutMs: number
  readonly #clock: () => number
  readonly #entries = new Map<string, Entry>()
  readonly #managed: ManagedWorkspaceManager | undefined
  readonly #uses = new Map<string, number>()

  constructor(opts: {
    provider: SandboxProvider
    policy: SandboxPolicy
    idleTimeoutMs: number
    clock?: () => number
    managed?: ManagedWorkspaceManager
  }) {
    this.#managed = opts.managed
    this.#provider = opts.provider
    this.#policy = opts.policy
    this.#idleTimeoutMs = opts.idleTimeoutMs
    this.#clock = opts.clock ?? Date.now
  }

  async getForThread(threadId: string, signal: AbortSignal): Promise<SandboxHandle> {
    if (this.#managed) return this.#managed.getForThread(threadId, signal)
    const existing = this.#entries.get(threadId)
    if (existing?.handle) {
      existing.lastUsedAt = this.#clock()
      return existing.handle
    }
    if (existing?.acquiring) return existing.acquiring

    const entry: Entry = { lastUsedAt: this.#clock(), inUse: 1 }
    this.#entries.set(threadId, entry)
    entry.acquiring = this.#provider
      .acquire({ threadId, policy: this.#policy, signal })
      .then((handle) => {
        entry.handle = handle
        delete entry.acquiring
        entry.lastUsedAt = this.#clock()
        return handle
      })
      .catch((err) => {
        this.#entries.delete(threadId)
        throw err
      })
      .finally(() => {
        entry.inUse -= 1
      })
    return entry.acquiring
  }

  async reapIdle(): Promise<void> {
    if (this.#managed) return this.#managed.reapIdle()
    const cutoff = this.#clock() - this.#idleTimeoutMs
    for (const [threadId, entry] of [...this.#entries]) {
      if (this.#uses.has(threadId) || entry.inUse > 0 || entry.acquiring) continue
      if (entry.lastUsedAt > cutoff) continue
      this.#entries.delete(threadId)
      await this.#provider.release(threadId)
    }
  }

  async destroyThread(threadId: string): Promise<void> {
    if (this.#managed) return this.#managed.destroyThread(threadId)
    if (this.#uses.has(threadId)) throw new Error("Sandbox has active execution")
    this.#entries.delete(threadId)
    await this.#provider.destroy(threadId)
  }

  async releaseAll(): Promise<void> {
    if (this.#managed) return this.#managed.releaseAll()
    if (this.#uses.size) throw new Error("Cannot release sandboxes while execution is active")
    const ids = [...this.#entries.keys()]
    this.#entries.clear()
    await Promise.all(ids.map((id) => this.#provider.release(id)))
  }
  async settle(threadId: string, signal: AbortSignal | undefined): Promise<void> {
    await this.#managed?.settle(threadId, signal)
  }
  get managed(): boolean {
    return this.#managed !== undefined
  }
  getWorkspace(threadId: string): AdmittedWorkspace | undefined {
    return this.#managed?.getWorkspace(threadId)
  }
  async reconcileDeletions(cleanup: (threadId: string) => Promise<void>): Promise<void> {
    await this.#managed?.reconcileDeletions(cleanup)
  }
  completeDelete(threadId: string): void {
    this.#managed?.completeDelete(threadId)
  }
  retain(threadId: string): () => void {
    if (this.#managed) return this.#managed.retain(threadId)
    this.#uses.set(threadId, (this.#uses.get(threadId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.#uses.get(threadId) ?? 1) - 1
      if (count) this.#uses.set(threadId, count)
      else this.#uses.delete(threadId)
      const entry = this.#entries.get(threadId)
      if (entry) entry.lastUsedAt = this.#clock()
    }
  }
}
