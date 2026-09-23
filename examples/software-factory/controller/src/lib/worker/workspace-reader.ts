import { withManagedWorkspaceReader } from "@b4run/cli/workspace"
import type {
  SandboxProvider,
  SandboxSecurityPolicy,
  SandboxWorkspaceReader,
} from "@b4run/workspace"
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
 * Which workspace to read. For the builder's reader the task id travels with the thread id
 * because inspection is not task-agnostic: the workspace definition puts a symlink in the
 * root whose target names the task, and a reader that does not know the task cannot state
 * the target it expects. The drafter's reader has one workspace shape for every thread and
 * is addressed by thread id alone.
 */
export interface WorkspaceTarget {
  readonly threadId: string
  readonly taskId?: string
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
  /**
   * Root-relative directory prefixes the builder may legitimately write under (the target's
   * build output); paths under them are dropped from the observed set, because the assembly
   * rule rejects any path the baseline lacks and build output is not a candidate. Inspection
   * cannot exclude nested directories, so this is a reader-side filter, the same prefixes the
   * verifier's tamper comparison skips. Matched against the keys inspection produces, which
   * are relative to `root` when one is set (not to the workspace root).
   */
  readonly ignorePrefixes?: readonly string[]
  /**
   * A canonical relative directory under the workspace root at which inspection STARTS.
   * Nothing outside it is walked, stat'ed or read, and every returned key is prefixed with
   * `<root>/` so the caller sees the same tree it would have kept from a whole-workspace
   * read. This is how the drafter's thread is readable at all: its `repo/` holds the wide
   * capture (executables, more bytes than an inspection allows), and only its `draft/` is
   * the controller's to read. A root that is absent, or not a directory, is
   * {@link WorkspaceRootMissingError}.
   */
  readonly root?: string
  readonly maxEntries?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}

/**
 * Inspection options for a task, supplied by whoever knows the workspace definitions. The
 * builder's derivation throws on an undefined task; the drafter's ignores it.
 */
export type WorkspaceInspectionOptions = (taskId: string | undefined) => WorkspaceReadOptions

/**
 * The read reached the thread's workspace and found no directory at `root`: `absent` when
 * no entry of that name exists, `not_directory` when one does but is a file or a link.
 * Distinct from a read that failed, so a caller can tell "the drafter wrote nothing under
 * `draft/`" (its fault, an attempt spent) from "the controller could not look" (nobody's
 * verdict), and can say which of the two the drafter did.
 */
export class WorkspaceRootMissingError extends Error {
  constructor(
    readonly root: string,
    threadId: string,
    readonly kind: "absent" | "not_directory",
  ) {
    super(
      `Workspace root ${JSON.stringify(root)} is ${kind === "absent" ? "missing" : "not a directory"} on thread ${JSON.stringify(threadId)}`,
    )
    this.name = "WorkspaceRootMissingError"
  }
}

/** `WorkspaceReadOptions.root` is not a canonical relative directory: refused before any open. */
export class InvalidWorkspaceRootError extends Error {
  constructor(readonly root: string) {
    super(`Invalid workspace read root: ${JSON.stringify(root)}`)
    this.name = "InvalidWorkspaceRootError"
  }
}

/**
 * The root's path segments, each a plain leaf name: no empty segment (so no leading,
 * trailing or doubled slash), no `.` or `..`, no backslash, no control character.
 */
function rootSegments(root: string): string[] {
  const segments = root.split("/")
  const valid = segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("\\") &&
      ![...segment].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
  )
  if (!valid) throw new InvalidWorkspaceRootError(root)
  return segments
}

/**
 * Establish that `segments` names a directory under the reader's root without touching any
 * sibling: each level is found by LISTING its parent (a name in a listing, not a stat that
 * may fail for reasons other than absence), and only the final entry is stat'ed. A missing
 * name or a non-directory is the typed error; any other failure is the read's own.
 */
async function requireDirectory(
  reader: SandboxWorkspaceReader,
  segments: readonly string[],
  root: string,
  signal: AbortSignal,
): Promise<string> {
  const ctx = { workspaceRoot: reader.workspaceRoot, signal }
  let current = reader.workspaceRoot.replace(/\/$/, "")
  for (const segment of segments) {
    const names = await reader.filesystem.listDir(current, ctx)
    if (!names.includes(segment))
      throw new WorkspaceRootMissingError(root, reader.threadId, "absent")
    current = `${current}/${segment}`
  }
  const metadata = await reader.filesystem.lstat(current, ctx)
  if (metadata.kind !== "directory")
    throw new WorkspaceRootMissingError(root, reader.threadId, "not_directory")
  return current
}

/**
 * Where the builder's workspaces live, as seen from the controller's process.
 *
 * The builder declares `sandbox.workspace`, so its threads are MANAGED workspaces: their
 * bytes live in storage named by the worker's installation and operation ids, which no
 * function of the thread id can reproduce. Resolving a thread therefore needs the worker's
 * own installation store under `appRoot` (read-only, without the worker's owner lock) as
 * well as a provider of the same kind, scope and image, constructed here.
 */
export interface ThreadWorkspaceSource {
  /**
   * Same kind, scope and image as the builder's `b4.config.ts` for that task. The image is
   * the one the builder booted with: its target's at the target's DEFAULT pin, whatever pin
   * the task itself runs at (the verifier's image, not the builder's). A target is a property
   * of the task, so the provider is resolved PER TASK rather than once for the process: one
   * provider for every task would address the wrong image as soon as a second target exists.
   * The drafter's source has one image and ignores the task; the builder's throws on an
   * undefined one.
   */
  providerFor(taskId: string | undefined): SandboxProvider
  /** The builder app's root: where `b4` keeps `.b4/workspaces` for that app. */
  readonly appRoot: string
}

/**
 * The real reader, over the framework's managed-workspace read surface.
 *
 * `withManagedWorkspaceReader` resolves the thread through the builder's installation store
 * to its published workspace record, then opens that record's storage read-only in a
 * separate, networkless container that never touches the builder's own session — which is
 * why this is safe to call while the builder sits idle between turns as well as after its
 * compute has been released. That is addressing, not authorization: naming a thread id is
 * not a claim of ownership, so the process holding the provider and the app root is the
 * boundary.
 *
 * The helper owns the reader's lifetime, including a close that fails: there is no `release`
 * for a caller to forget, and a close failure is aggregated with a read failure rather than
 * replacing it.
 */
export function createThreadWorkspaceReader(
  source: ThreadWorkspaceSource,
  optionsFor: WorkspaceInspectionOptions,
): WorkspaceReader {
  return {
    async read(target, signal) {
      // Resolved before anything is opened: a task whose inspection options cannot be
      // derived is a refusal that costs no container and no store lookup.
      const options = optionsFor(target.taskId)
      // Likewise a malformed root: refused before a store lookup or a container.
      const root = options.root
      const segments = root === undefined ? undefined : rootSegments(root)
      const inspection = await withManagedWorkspaceReader(
        {
          appRoot: source.appRoot,
          provider: source.providerFor(target.taskId),
          threadId: target.threadId,
          signal,
          ...(options.runAsNonRoot === undefined ? {} : { runAsNonRoot: options.runAsNonRoot }),
        },
        // A `SandboxWorkspaceReader` is a `WorkspaceReadSource`: filesystem and
        // workspaceRoot, no exec backend and no write operation anywhere on it, which is
        // all `inspectWorkspace` consumes. With a `root`, inspection is handed the SAME
        // filesystem at a nested `workspaceRoot`: its walk starts there and never leaves it.
        async (reader) => {
          const workspaceRoot =
            root === undefined || segments === undefined
              ? reader.workspaceRoot
              : await requireDirectory(reader, segments, root, signal)
          return inspectWorkspace(
            { filesystem: reader.filesystem, workspaceRoot },
            {
              signal,
              maxEntries: options.maxEntries ?? 10_000,
              maxFileBytes: options.maxFileBytes ?? 2 * 1024 * 1024,
              maxTotalBytes: options.maxTotalBytes ?? 16 * 1024 * 1024,
              excludeRootDirectories: options.excludeRootDirectories,
              expectedRootSymlinks: options.expectedRootSymlinks,
            },
          )
        },
      )
      const ignored = options.ignorePrefixes ?? []
      // Re-prefixed exactly once: inspection's keys are relative to the nested root.
      const rootPrefix = root === undefined ? "" : `${root}/`
      return new Map(
        Object.entries(inspection.files)
          .filter(([path]) => !ignored.some((prefix) => path.startsWith(prefix)))
          .map(([path, content]) => [`${rootPrefix}${path}`, content]),
      )
    },
  }
}
