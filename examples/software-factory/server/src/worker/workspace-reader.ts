import type { SandboxHandle } from "@b4run/workspace"
import { inspectWorkspace } from "@b4run/workspace"

/**
 * Read a builder thread's workspace after its turn has ended. The controller uses
 * this to obtain candidate bytes it does not trust, which it then validates
 * against its own captured baseline. Implementations must never mutate the
 * workspace and must never disturb a live sandbox.
 */
export interface WorkspaceReader {
  read(target: WorkspaceTarget, signal: AbortSignal): Promise<ReadonlyMap<string, string>>
}

/**
 * Which workspace to read. The task id travels with the thread id because inspection is not
 * task-agnostic: the workspace definition puts a symlink in the root whose target names the
 * task, and a reader that does not know the task cannot state the target it expects.
 */
export interface WorkspaceTarget {
  readonly threadId: string
  readonly taskId: string
}

/**
 * How to inspect one task's workspace.
 *
 * The two structural options are REQUIRED, not optional with an absent default. Every
 * workspace this controller reads has a git baseline and a dependency symlink, so a reader
 * built without them either throws on the symlink or reports the git directory as added
 * paths — a scope violation on every single run. An option that is silently absent is the
 * kind of default that makes a swap-in look like it worked.
 */
export interface HandleReaderOptions {
  /** Root leaf names whose subtrees may be absent, e.g. the git directory. */
  readonly excludeRootDirectories: readonly string[]
  /** Required root symlinks and their exact targets, e.g. the dependency link. */
  readonly expectedRootSymlinks: Readonly<Record<string, string>>
  readonly maxEntries?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}

/** Inspection options for a task, supplied by whoever knows the workspace definitions. */
export type WorkspaceInspectionOptions = (taskId: string) => HandleReaderOptions

/**
 * Adapter over whatever the framework's read-only thread-workspace surface hands
 * back. It is written against `SandboxHandle` because that is what
 * `inspectWorkspace` accepts; when the surface lands, `attach` is the only thing
 * that changes.
 */
export function createHandleWorkspaceReader(
  attach: (
    target: WorkspaceTarget,
    signal: AbortSignal,
  ) => Promise<{
    readonly handle: SandboxHandle
    readonly release: () => Promise<void>
  }>,
  optionsFor: WorkspaceInspectionOptions,
): WorkspaceReader {
  return {
    async read(target, signal) {
      // Resolved before anything is attached: a task whose inspection options cannot be
      // derived is a refusal that costs no container.
      const options = optionsFor(target.taskId)
      const { handle, release } = await attach(target, signal)
      try {
        const inspection = await inspectWorkspace(handle, {
          signal,
          maxEntries: options.maxEntries ?? 10_000,
          maxFileBytes: options.maxFileBytes ?? 2 * 1024 * 1024,
          maxTotalBytes: options.maxTotalBytes ?? 16 * 1024 * 1024,
          excludeRootDirectories: options.excludeRootDirectories,
          expectedRootSymlinks: options.expectedRootSymlinks,
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
 * Only the Docker-gated lane needs this; every other layer uses the fake. When the surface
 * lands, the body below becomes
 *
 *     return createHandleWorkspaceReader(
 *       async (target, signal) => withWorkspaceReader(provider, { threadId: target.threadId, signal }),
 *       optionsFor,
 *     )
 *
 * and this comment goes away. `optionsFor` is required here, although the placeholder can
 * only refuse, for exactly that reason: the inspection options the replacement must carry
 * are already at the call site, so the swap is one function body rather than a silent loss
 * of `excludeRootDirectories` and `expectedRootSymlinks` — which would throw on the
 * dependency symlink, or report the git directory as added paths, on every run.
 */
export function createThreadWorkspaceReader(
  optionsFor: WorkspaceInspectionOptions,
): WorkspaceReader {
  // Called for its refusal, not its result: an unknown task is worth refusing on here too,
  // and it keeps this function's contract identical to the one that replaces it.
  return {
    async read(target) {
      optionsFor(target.taskId)
      throw new Error(
        `Cannot read thread ${target.threadId}'s workspace: ${THREAD_WORKSPACE_READER_GAP}`,
      )
    },
  }
}

/**
 * Why {@link createThreadWorkspaceReader} cannot read anything yet, in one line an
 * operator can act on.
 *
 * It exists so the absence is announced rather than discovered: a controller built
 * on the real reader reaches `verifying`, fails the read, journals
 * `workspace_unreadable` and settles every work order as
 * `verification_inconclusive`. That is the correct behaviour, but on its own it
 * looks like a flaky verifier. The command line prints this at startup so the
 * cause is known before the first dispatch, not inferred from the journal after
 * it.
 *
 * Delete this together with the placeholder when pull request #731 lands.
 */
export const THREAD_WORKSPACE_READER_GAP =
  "the framework's read-only thread-workspace surface (SandboxProvider.openWorkspaceReader) " +
  "is not in this build; it is proposed in pull request #731 and still open. Until it merges " +
  "the controller cannot obtain candidate bytes, so every work order settles as " +
  "verification_inconclusive with a workspace_unreadable event."
