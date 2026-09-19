import type { SandboxProvider, SandboxSecurityPolicy } from "@b4run/workspace"
import { inspectWorkspace, withWorkspaceReader } from "@b4run/workspace"

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
export interface WorkspaceReadOptions {
  /** Root leaf names whose subtrees may be absent, e.g. the git directory. */
  readonly excludeRootDirectories: readonly string[]
  /** Required root symlinks and their exact targets, e.g. the dependency link. */
  readonly expectedRootSymlinks: Readonly<Record<string, string>>
  /**
   * The identity the reader runs as, in the sandbox policy's own vocabulary. Absent means
   * the provider's secure default, which owns a workspace produced under the default
   * policy; it must mirror the BUILDER's policy, because a workspace whose files are
   * root-owned under a relaxed policy is unreadable to a reader running as 1000:1000.
   * Derived from the policy rather than restated here, for exactly that reason.
   */
  readonly runAsNonRoot?: SandboxSecurityPolicy["runAsNonRoot"]
  readonly maxEntries?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}

/** Inspection options for a task, supplied by whoever knows the workspace definitions. */
export type WorkspaceInspectionOptions = (taskId: string) => WorkspaceReadOptions

/**
 * The real reader, over the framework's read-only thread-workspace surface.
 *
 * `provider` is the controller's OWN handle on the builder's sandbox storage: the same
 * provider kind, scope and image the builder is configured with, constructed in this
 * process. That is addressing, not authorization — naming a thread id is not a claim of
 * ownership — so the process holding it is the boundary. `openWorkspaceReader` attaches the
 * thread's workspace volume read-only in a separate, networkless container and never touches
 * the thread's own sandbox, which is why this is safe to call while the builder sits idle
 * between turns as well as after its compute has been released.
 *
 * `withWorkspaceReader` owns the reader's lifetime, including a close that fails: there is
 * no `release` for a caller to forget, and a close failure is aggregated with a read failure
 * rather than replacing it.
 */
export function createThreadWorkspaceReader(
  provider: SandboxProvider,
  optionsFor: WorkspaceInspectionOptions,
): WorkspaceReader {
  return {
    async read(target, signal) {
      // Resolved before anything is opened: a task whose inspection options cannot be
      // derived is a refusal that costs no container.
      const options = optionsFor(target.taskId)
      const inspection = await withWorkspaceReader(
        provider,
        {
          threadId: target.threadId,
          signal,
          ...(options.runAsNonRoot === undefined ? {} : { runAsNonRoot: options.runAsNonRoot }),
        },
        // A `SandboxWorkspaceReader` is a `WorkspaceReadSource`: filesystem and
        // workspaceRoot, no exec backend and no write operation anywhere on it, which is
        // all `inspectWorkspace` consumes.
        (reader) =>
          inspectWorkspace(reader, {
            signal,
            maxEntries: options.maxEntries ?? 10_000,
            maxFileBytes: options.maxFileBytes ?? 2 * 1024 * 1024,
            maxTotalBytes: options.maxTotalBytes ?? 16 * 1024 * 1024,
            excludeRootDirectories: options.excludeRootDirectories,
            expectedRootSymlinks: options.expectedRootSymlinks,
          }),
      )
      return new Map(Object.entries(inspection.files))
    },
  }
}
