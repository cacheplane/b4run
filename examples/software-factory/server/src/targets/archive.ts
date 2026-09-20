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
}

/** Who a capture is for: each captures into its own directory, never sharing one. */
export type CaptureRole = "builder" | "controller" | "verifier" | "reference" | "test"

const ROLE_PATTERN = /^[\w-]+$/
const TASK_ID_PATTERN = /^[\w-]+$/

/**
 * The baseline for a task: the target's pinned subtree with the task's defect applied.
 *
 * Archived from the repository's object store, never its working tree, so uncommitted edits
 * are invisible and two captures of one pin are byte-identical. Extracted under the app root
 * because the framework's capture takes an app-relative path, and per `role` because the
 * builder's process and the controller's process each capture for themselves and must not
 * rebuild one directory under each other. Synchronous because `b4.config.ts` needs the
 * builder's copy at load time. Rebuilt on every call: there is no cache to invalidate.
 *
 * Built into a scratch sibling and renamed into place only once the archive, extraction and
 * defect patch have all succeeded, so a failed capture leaves nothing at all behind — no
 * partial `absolute` directory and no scratch directory beside it.
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
  if (!ROLE_PATTERN.test(role)) throw new Error(`Invalid capture role: ${role}`)
  if (!TASK_ID_PATTERN.test(task.id)) throw new Error(`Invalid task id: ${task.id}`)
  const appRoot = options.appRoot ?? defaultAppRoot
  const repo = options.repositoryRoot ?? defaultRepositoryRoot()
  const directory = `.factory/captures/${role}/${task.id}`
  const absolute = join(appRoot, ".factory", "captures", role, task.id)
  const scratch = join(appRoot, ".factory", "captures", role, `.${task.id}.tmp-${process.pid}`)
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })

  try {
    const { pin, root, capture } = task.target
    const treeish = root === "." ? pin : `${pin}:${root}`
    // Scratch files live INSIDE the scratch directory so nothing survives beside the capture
    // even on failure: the whole scratch directory is removed in the catch below.
    const tar = join(scratch, ".b4-archive.tar")
    try {
      execFileSync(
        "git",
        ["-C", repo, "archive", "--format=tar", "-o", tar, treeish, "--", ...capture.include],
        { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000, encoding: "utf8" },
      )
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error)
      throw new Error(`Task ${task.id}: git archive of ${treeish} failed: ${stderr}`, {
        cause: error,
      })
    }
    try {
      execFileSync("tar", ["-xf", tar, "-C", scratch], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 60_000,
        encoding: "utf8",
      })
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error)
      throw new Error(`Task ${task.id}: tar extraction of ${treeish} failed: ${stderr}`, {
        cause: error,
      })
    } finally {
      rmSync(tar, { force: true })
    }

    for (const path of capture.include)
      if (!existsSync(join(scratch, path)))
        throw new Error(
          `Task ${task.id}: include path ${path} is absent from the archive of ${treeish}`,
        )

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
