import { readThreadWorkspace, ThreadWorkspaceReadError } from "@b4run/cli/workspace"

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
  /** The source the controller handed this thread: the worker's answer must carry it. */
  readonly sourceDigest: string
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
   * Root-relative directory prefixes the builder may legitimately write under (the target's
   * build output); paths under them are dropped from the observed set, because the assembly
   * rule rejects any path the baseline lacks and build output is not a candidate. Inspection
   * cannot exclude nested directories, so this is a filter after the walk: the worker applies
   * it to its answer and the reader applies it again, so the observed set does not depend on
   * the worker's version. Matched against the keys inspection produces, which are relative to
   * `root` when one is set (not to the workspace root).
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

/** A worker as the reader reaches it: its Agent Protocol base URL and the worker token. */
export interface ThreadWorkspaceEndpoint {
  readonly url: string
  readonly token: string
  readonly fetch?: typeof fetch
}

/**
 * The journal's hint for a 404 that carries no code. A worker that serves the read answers a
 * missing thread with `thread_not_found` and a missing workspace with `workspace_lost`; a bare
 * 404 is the route itself being absent, which is what a worker without
 * `sandbox.workspaceRead: "http"` answers (an operator's configuration, not the thread's).
 */
export const WORKSPACE_READ_NOT_SERVED_HINT =
  'the worker answered 404 with no code: it may not set sandbox.workspaceRead: "http" (or the URL is not a B4.run worker)'

/**
 * What a failed read said, for the journal: the worker's HTTP status and code
 * (`workspace_changed`, `workspace_read_timeout`, `run_in_flight`, ...) or the client's own
 * (`source_mismatch`, `thread_mismatch`, ...), and a hint for a bare 404. Empty for a failure
 * that is neither.
 */
export function workspaceReadFailure(error: unknown): {
  status?: number
  code?: string
  hint?: string
} {
  if (!(error instanceof ThreadWorkspaceReadError)) return {}
  return {
    status: error.status,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.status === 404 && error.code === undefined
      ? { hint: WORKSPACE_READ_NOT_SERVED_HINT }
      : {}),
  }
}

/**
 * The worker's refusal is the missing-root verdict only when every part of it says so: the
 * worker's own status for it (422), its code, and the root it names being the one asked for. A
 * code alone on another status, or a refusal about another root, is a read the controller
 * could not make, not a verdict on the thread's output.
 */
function isRootMissing(error: unknown, root: string): error is ThreadWorkspaceReadError {
  return (
    error instanceof ThreadWorkspaceReadError &&
    error.status === 422 &&
    error.code === "workspace_root_missing" &&
    error.details.root === root
  )
}

/**
 * The real reader: `POST /threads/:id/workspace/inspect` on the worker that holds the thread
 * (`sandbox.workspaceRead: "http"`). The worker runs the read in a separate, networkless,
 * read-only container that never touches the thread's session, holding the thread's run
 * slot, so it is safe between turns and refused (`run_in_flight`) during one. This process
 * holds only the URL, the token and the digest it handed over: no installation store, no
 * volume, no daemon of the worker's.
 *
 * Every refusal but one stays the client's `ThreadWorkspaceReadError`, whose status and code
 * the phases journal ({@link workspaceReadFailure}) as a read they could not make. The one
 * exception is a missing `root`, which is a verdict on the thread's output.
 */
export function createHttpThreadWorkspaceReader(
  endpoint: ThreadWorkspaceEndpoint,
  optionsFor: WorkspaceInspectionOptions,
): WorkspaceReader {
  return {
    async read(target, signal) {
      // Refused before a request: options that cannot be derived, or a malformed root.
      const options = optionsFor(target.taskId)
      const root = options.root
      if (root !== undefined) rootSegments(root)
      const ignored = options.ignorePrefixes ?? []
      let answer: Awaited<ReturnType<typeof readThreadWorkspace>>
      try {
        answer = await readThreadWorkspace(
          endpoint.url,
          target.threadId,
          {
            ...(root !== undefined ? { root } : {}),
            excludeRootDirectories: options.excludeRootDirectories,
            expectedRootSymlinks: options.expectedRootSymlinks,
            ...(options.ignorePrefixes !== undefined
              ? { ignorePrefixes: options.ignorePrefixes }
              : {}),
            maxEntries: options.maxEntries ?? 10_000,
            maxFileBytes: options.maxFileBytes ?? 2 * 1024 * 1024,
            maxTotalBytes: options.maxTotalBytes ?? 16 * 1024 * 1024,
          },
          {
            headers: { authorization: `Bearer ${endpoint.token}` },
            signal,
            expectedSourceDigest: target.sourceDigest,
            ...(endpoint.fetch ? { fetch: endpoint.fetch } : {}),
          },
        )
      } catch (error) {
        // The one refusal that is a verdict on the thread's output: the worker reached the
        // workspace and found nothing (or not a directory) at `root`.
        if (root !== undefined && isRootMissing(error, root))
          throw new WorkspaceRootMissingError(
            root,
            target.threadId,
            error.details.kind === "not_directory" ? "not_directory" : "absent",
          )
        throw error
      }
      // Re-prefixed exactly once: the worker's keys are relative to the root.
      const rootPrefix = root === undefined ? "" : `${root}/`
      return new Map(
        Object.entries(answer.inspection.files)
          .filter(([path]) => !ignored.some((prefix) => path.startsWith(prefix)))
          .map(([path, content]) => [`${rootPrefix}${path}`, content]),
      )
    },
  }
}
