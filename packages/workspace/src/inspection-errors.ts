/**
 * A bounded read found more bytes than it was allowed. Thrown by B4.run's own
 * backends (`localFilesystem`, the sandbox providers' bounded reads) with their
 * historic messages, so a caller can tell "this file is over the cap" from an
 * I/O failure without matching text. Recognized by NAME as well as by class
 * ({@link isWorkspaceReadLimitError}): a provider package can resolve its own
 * copy of `@b4run/workspace`, and `instanceof` across two copies is false.
 */
export class WorkspaceReadLimitError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly maxBytes: number,
  ) {
    super(message)
    this.name = "WorkspaceReadLimitError"
  }
}

export function isWorkspaceReadLimitError(error: unknown): error is WorkspaceReadLimitError {
  return error instanceof Error && error.name === "WorkspaceReadLimitError"
}

/**
 * Why `inspectWorkspace` refused, as data:
 *
 * - `invalid_options`: the caller's options (a limit, a root, a policy name) are
 *   malformed. Nothing was read.
 * - `root_missing`: `root` names nothing, or names something that is not a
 *   directory (`detail.kind`). The workspace was reached.
 * - `refused`: the workspace holds something the inspection does not admit
 *   (a limit, an executable, binary or non-UTF-8 file, an unexpected link).
 * - `changed`: the workspace changed while it was being read. Retry once the
 *   writer is quiet.
 *
 * Anything else a backend throws is left as it was thrown.
 */
export type WorkspaceInspectionErrorCode =
  | "invalid_options"
  | "root_missing"
  | "refused"
  | "changed"

export interface WorkspaceInspectionErrorDetail {
  readonly root?: string
  readonly kind?: "absent" | "not_directory"
}

export class WorkspaceInspectionError extends Error {
  constructor(
    readonly code: WorkspaceInspectionErrorCode,
    message: string,
    readonly detail: WorkspaceInspectionErrorDetail = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "WorkspaceInspectionError"
  }
}

/**
 * The one rule for an inspection `root`: relative, `/`-separated leaf names, none
 * empty, `.`, `..`, containing `\\` or a control character. Shared by
 * `inspectWorkspace` and by the HTTP endpoint, which refuses a bad root before it
 * starts a reader.
 */
export function isCanonicalWorkspaceRoot(root: string): boolean {
  return (
    typeof root === "string" &&
    root.length > 0 &&
    root.length <= 1024 &&
    root
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          !segment.includes("\\") &&
          ![...segment].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
      )
  )
}

const CODES: ReadonlySet<string> = new Set([
  "invalid_options",
  "root_missing",
  "refused",
  "changed",
])

export function isWorkspaceInspectionError(error: unknown): error is WorkspaceInspectionError {
  return (
    error instanceof Error &&
    error.name === "WorkspaceInspectionError" &&
    CODES.has(String((error as { readonly code?: unknown }).code))
  )
}
