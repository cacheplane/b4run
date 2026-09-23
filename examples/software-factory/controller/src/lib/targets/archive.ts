import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  appRoot as defaultAppRoot,
  repositoryRoot as defaultRepositoryRoot,
  type Task,
} from "./catalog.js"

export interface CapturedTarget {
  /** App-relative, forward-slash: what the framework's capture accepts. */
  readonly directory: string
  readonly absolute: string
}

export interface CaptureTargetOptions {
  readonly appRoot?: string
  readonly repositoryRoot?: string
  /**
   * Distinguishes concurrent captures of the same role and task from one another: without it,
   * a second capture of a task already in flight (the controller captures once per
   * verification and again at approve, with no serialization between them) can rename a fresh
   * directory into place while the first capture's `captureWorkspaceSource` is still walking
   * it, which that walk sees as the source changing under it mid-read. When present, the
   * capture lives at `.factory/captures/<role>/<taskId>.<instance>` instead of the shared,
   * role-and-task-keyed directory.
   */
  readonly instance?: string
}

/** Who a capture is for: each captures into its own directory, never sharing one. */
export type CaptureRole = "builder" | "controller" | "verifier" | "reference" | "test" | "drafter"

const ROLE_PATTERN = /^[\w-]+$/
const TASK_ID_PATTERN = /^[\w-]+$/
const INSTANCE_PATTERN = /^[\w-]+$/

/**
 * The app-relative directory one capture lives at: `.factory/captures/<role>/<taskId>` or,
 * with an `instance`, `.factory/captures/<role>/<taskId>.<instance>`. The one place this
 * formula is written, so `captureTarget` and any caller that needs to name (rather than
 * create) a capture's directory — such as removing an instance directory a failed capture
 * left behind — cannot drift apart from it.
 */
export function captureDirectory(taskId: string, role: CaptureRole, instance?: string): string {
  if (!ROLE_PATTERN.test(role)) throw new Error(`Invalid capture role: ${role}`)
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`Invalid task id: ${taskId}`)
  if (instance !== undefined && !INSTANCE_PATTERN.test(instance))
    throw new Error(`Invalid capture instance: ${instance}`)
  const name = instance === undefined ? taskId : `${taskId}.${instance}`
  return `.factory/captures/${role}/${name}`
}

/** The include list is passed on `git archive`'s command line; this is the ceiling it may add up to. */
export const MAX_ARCHIVE_ARGV_BYTES = 512 * 1024

/** The include list would not fit on a command line: thrown before git is invoked. */
export class ArchiveArgumentsError extends Error {
  override readonly name = "ArchiveArgumentsError"
}

export interface ArchiveTreeOptions {
  /** A directory prefix inside `destination` (`repo/`) the archive is extracted under. */
  readonly prefix?: string
  /** Names the caller in error messages: `Task k`, `wide capture`. */
  readonly label: string
}

/**
 * `git archive` the paths `include` of `treeish` in `repo` and extract them into
 * `destination` (which must already exist), under `options.prefix` when given. Synchronous:
 * `b4.config.ts` needs the builder's copy at load time, and nothing here honours a signal.
 *
 * Archived from the object store, never the working tree, so uncommitted edits are
 * invisible and two archives of one tree-ish are byte-identical; the tar carries each
 * blob's mode, so an executable keeps its bit on disk. The tar itself lives INSIDE
 * `destination` so a failure leaves nothing beside it (the caller removes `destination`).
 *
 * The include list goes on the command line, so its size is checked first: a list past
 * {@link MAX_ARCHIVE_ARGV_BYTES} is refused by name rather than by the platform's `E2BIG`.
 * `git archive` silently honours an in-tree `.gitattributes export-ignore`, so every
 * included path is asserted present in the extracted tree afterwards.
 */
export function archiveTreeInto(
  repo: string,
  treeish: string,
  include: readonly string[],
  destination: string,
  options: ArchiveTreeOptions,
): void {
  const { label } = options
  const prefix = options.prefix ?? ""
  let argvBytes = 0
  for (const path of include) argvBytes += Buffer.byteLength(path) + 1
  if (argvBytes > MAX_ARCHIVE_ARGV_BYTES)
    throw new ArchiveArgumentsError(
      `${label}: the include list of ${treeish} is ${argvBytes} bytes of arguments, over the ${MAX_ARCHIVE_ARGV_BYTES}-byte ceiling for one git archive command`,
    )
  const tar = join(destination, ".b4-archive.tar")
  try {
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "archive",
        "--format=tar",
        ...(prefix ? [`--prefix=${prefix}`] : []),
        "-o",
        tar,
        treeish,
        "--",
        ...include,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000, encoding: "utf8" },
    )
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error)
    throw new Error(`${label}: git archive of ${treeish} failed: ${stderr}`, { cause: error })
  }
  try {
    execFileSync("tar", ["-xf", tar, "-C", destination], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000,
      encoding: "utf8",
    })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error)
    throw new Error(`${label}: tar extraction of ${treeish} failed: ${stderr}`, {
      cause: error,
    })
  } finally {
    rmSync(tar, { force: true })
  }
  for (const path of include)
    if (!existsSync(join(destination, prefix, path)))
      throw new Error(
        `${label}: include path ${path} is absent from the archive of ${treeish} extracted into ${destination} (a .gitattributes export-ignore at the pin is the likely cause)`,
      )
}

/**
 * The baseline for a task: the target's pinned subtree with the task's defect applied.
 *
 * Archived from the repository's object store, never its working tree, so uncommitted edits
 * are invisible and two captures of one pin are byte-identical. Extracted under the app root
 * because the framework's capture takes an app-relative path, and per `role` because the
 * builder's process and the controller's process each capture for themselves and must not
 * rebuild one directory under each other. Per `options.instance` too, when given, because one
 * role can itself have more than one capture in flight at once (see {@link CaptureTargetOptions}).
 * Synchronous because `b4.config.ts` needs the builder's copy at load time. Rebuilt on every
 * call: there is no cache to invalidate.
 *
 * Built into a scratch sibling and renamed into place only once the archive, extraction and
 * defect patch have all succeeded, so a failed capture leaves the previous capture at
 * `absolute` in place (or nothing, if there was none) and no scratch directory beside it.
 *
 * `git archive` silently honours an in-tree `.gitattributes export-ignore`: an included path
 * can vanish from the archive with no error. Every entry of `capture.include` is therefore
 * asserted present in the extracted tree before the defect patch is applied.
 */
export function captureTarget(
  task: Task,
  role: CaptureRole,
  options: CaptureTargetOptions = {},
): CapturedTarget {
  const directory = captureDirectory(task.id, role, options.instance)
  const appRoot = options.appRoot ?? defaultAppRoot
  const repo = options.repositoryRoot ?? defaultRepositoryRoot()
  const name = options.instance === undefined ? task.id : `${task.id}.${options.instance}`
  const absolute = join(appRoot, directory)
  const scratch = join(appRoot, ".factory", "captures", role, `.${name}.tmp-${process.pid}`)
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })

  try {
    const { pin, root, capture } = task.target
    const treeish = root === "." ? pin : `${pin}:${root}`
    archiveTreeInto(repo, treeish, capture.include, scratch, { label: `Task ${task.id}` })

    if (task.defectPatch !== null) {
      const patch = join(scratch, ".b4-defect.patch")
      writeFileSync(patch, task.defectPatch)
      try {
        // `-c core.autocrlf=false` and `--whitespace=nowarn` keep ambient git config (a
        // developer's `apply.whitespace=fix`, say) from rewriting the applied bytes: two
        // captures of one pin must be byte-identical.
        const applied = spawnSync(
          "git",
          ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", patch],
          { cwd: scratch, encoding: "utf8", timeout: 60_000 },
        )
        if (applied.error)
          throw new Error(`Task ${task.id}: git apply could not run: ${String(applied.error)}`, {
            cause: applied.error,
          })
        if (applied.status !== 0)
          throw new Error(
            `Task ${task.id}: defect patch did not apply to ${pin} ` +
              `(status ${applied.status}, signal ${applied.signal}):\n${applied.stderr}`,
          )
      } finally {
        rmSync(patch, { force: true })
      }
    }

    rmSync(absolute, { recursive: true, force: true })
    renameSync(scratch, absolute)
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
  return { directory, absolute }
}
