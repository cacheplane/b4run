import { dockerSandbox } from "@b4run/sandbox"
import { loadManifest, selectFixture } from "./fixture-catalog.js"
import { ownedProvider } from "./owned-provider.js"
import { collectChanges, renderReviewDiff, snapshot } from "./patch.js"
import { seedFixture } from "./seed-fixture.js"
import { seededProvider } from "./seeded-provider.js"
import { sandboxImage, verifyChanges } from "./verifier.js"

function createContext() {
  const task = selectFixture(process.env.B4_CODE_FIXER_TASK ?? "cli-flags")
  const baselines = new Map<string, Record<string, string>>()
  const provider = seededProvider(
    ownedProvider(dockerSandbox({ image: sandboxImage })),
    async (handle, signal) => {
      await seedFixture(task, handle, signal)
      baselines.set(handle.threadId, await snapshot(handle, signal))
    },
  )
  return {
    task,
    provider,
    async verify(signal: AbortSignal) {
      if (provider.handles.size !== 1) throw new Error("Expected exactly one active attempt")
      const handle = [...provider.handles.values()][0]
      if (!handle) throw new Error("Attempt not started")
      const baseline = baselines.get(handle.threadId)
      if (!baseline) throw new Error("Attempt baseline missing")
      const manifest = await loadManifest(task)
      const changes = collectChanges(
        baseline,
        await snapshot(handle, signal),
        manifest.allowedSourcePaths,
      )
      const verification = await verifyChanges(task, changes, signal)
      return {
        task,
        threadId: handle.threadId,
        changes,
        diff: renderReviewDiff(baseline, changes),
        verification,
      }
    },
  }
}

// Config loaders and authored tools can use separate module caches. The attempt
// runs in a dedicated host process, so this registry binds them without passing
// authority or receipt paths through model arguments.
const key = Symbol.for("b4.code-fixer.attempt")
const host = globalThis as typeof globalThis & { [key]?: ReturnType<typeof createContext> }
export function attemptContext() {
  if (!host[key]) host[key] = createContext()
  return host[key]
}
