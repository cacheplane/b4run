import type { SandboxHandle } from "@b4run/workspace"
import { inspectWorkspace } from "@b4run/workspace"

/**
 * Read a builder thread's workspace after its turn has ended. The controller uses
 * this to obtain candidate bytes it does not trust, which it then validates
 * against its own captured baseline. Implementations must never mutate the
 * workspace and must never disturb a live sandbox.
 */
export interface WorkspaceReader {
  read(threadId: string, signal: AbortSignal): Promise<ReadonlyMap<string, string>>
}

export interface HandleReaderOptions {
  /** Root leaf names whose subtrees may be absent, e.g. the git directory. */
  readonly excludeRootDirectories?: readonly string[]
  /** Required root symlinks and their exact targets, e.g. the dependency link. */
  readonly expectedRootSymlinks?: Readonly<Record<string, string>>
  readonly maxEntries?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}

/**
 * Adapter over whatever the framework's read-only thread-workspace surface hands
 * back. It is written against `SandboxHandle` because that is what
 * `inspectWorkspace` accepts; when the surface lands, `attach` is the only thing
 * that changes.
 */
export function createHandleWorkspaceReader(
  attach: (
    threadId: string,
    signal: AbortSignal,
  ) => Promise<{
    readonly handle: SandboxHandle
    readonly release: () => Promise<void>
  }>,
  options: HandleReaderOptions = {},
): WorkspaceReader {
  return {
    async read(threadId, signal) {
      const { handle, release } = await attach(threadId, signal)
      try {
        const inspection = await inspectWorkspace(handle, {
          signal,
          maxEntries: options.maxEntries ?? 10_000,
          maxFileBytes: options.maxFileBytes ?? 2 * 1024 * 1024,
          maxTotalBytes: options.maxTotalBytes ?? 16 * 1024 * 1024,
          ...(options.excludeRootDirectories
            ? { excludeRootDirectories: options.excludeRootDirectories }
            : {}),
          ...(options.expectedRootSymlinks
            ? { expectedRootSymlinks: options.expectedRootSymlinks }
            : {}),
        })
        return new Map(Object.entries(inspection.files))
      } finally {
        await release()
      }
    },
  }
}

/**
 * The real reader, over the framework's read-only thread-workspace surface.
 *
 * That surface is `SandboxProvider.openWorkspaceReader`, proposed in pull request
 * #731 and still open: it is not in this branch's `@b4run/workspace` or
 * `@b4run/sandbox`, so there is nothing here to adapt yet. Until it lands this
 * throws with a clear message rather than reaching into internals, because both
 * workarounds are worse than an honest absence. Acquiring the builder's sandbox
 * from this process would REPLACE its container — `acquire` is idempotent only
 * within one provider lifecycle — and deriving the volume name depends on
 * `resourceScope`, which is unexported addressing and not an ownership check.
 *
 * Only the Docker-gated lane needs this; every other layer uses the fake. When
 * the surface lands, this becomes `createHandleWorkspaceReader` over
 * `withWorkspaceReader(provider, { threadId, signal }, ...)` and this comment goes
 * away.
 */
export function createThreadWorkspaceReader(): WorkspaceReader {
  return {
    async read(threadId) {
      throw new Error(
        `Reading thread ${threadId}'s workspace needs the framework's read-only thread-workspace surface, which is not available in this build`,
      )
    },
  }
}
