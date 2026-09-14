import type { SandboxHandle, SandboxProvider } from "@b4run/workspace"
export function seededProvider(
  base: SandboxProvider,
  seed: (handle: SandboxHandle, signal: AbortSignal) => Promise<void>,
) {
  const handles = new Map<string, SandboxHandle>()
  const initialized = new Set<string>()
  const pending = new Map<string, Promise<SandboxHandle>>()
  const provider: SandboxProvider & {
    handles: ReadonlyMap<string, SandboxHandle>
    destroyAll(): Promise<void>
  } = {
    name: `seeded-${base.name}`,
    handles,
    ...(base.preflight ? { preflight: base.preflight.bind(base) } : {}),
    async acquire(input) {
      const active = pending.get(input.threadId)
      if (active) return active
      const operation = (async () => {
        const handle = await base.acquire(input)
        handles.set(input.threadId, handle)
        try {
          if (!initialized.has(input.threadId)) {
            await seed(handle, input.signal)
            initialized.add(input.threadId)
          }
          return handle
        } catch (error) {
          await provider.destroy(input.threadId)
          throw error
        }
      })()
      pending.set(input.threadId, operation)
      try {
        return await operation
      } finally {
        pending.delete(input.threadId)
      }
    },
    release: (id) => base.release(id),
    async destroy(id) {
      await base.destroy(id)
      handles.delete(id)
      initialized.delete(id)
    },
    async destroyAll() {
      const results = await Promise.allSettled(
        [...handles.keys()].map((id) => provider.destroy(id)),
      )
      const failures = results.filter((r) => r.status === "rejected")
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => r.reason),
          "Sandbox cleanup failed",
        )
    },
  }
  return provider
}
