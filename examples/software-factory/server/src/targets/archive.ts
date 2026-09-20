import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
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

/**
 * The baseline for a task: the target's pinned subtree with the task's defect applied.
 *
 * Archived from the repository's object store, never its working tree, so uncommitted edits
 * are invisible and two captures of one pin are byte-identical. Extracted under the app root
 * because the framework's capture takes an app-relative path, and per `role` because the
 * builder's process and the controller's process each capture for themselves and must not
 * rebuild one directory under each other. Synchronous because `b4.config.ts` needs the
 * builder's copy at load time. Rebuilt on every call: there is no cache to invalidate.
 */
export function captureTarget(
  task: Task,
  role: string,
  options: CaptureTargetOptions = {},
): CapturedTarget {
  if (!/^[\w-]+$/.test(role)) throw new Error(`Invalid capture role: ${role}`)
  const appRoot = options.appRoot ?? defaultAppRoot
  const repo = options.repositoryRoot ?? defaultRepositoryRoot()
  const directory = `.factory/captures/${role}/${task.id}`
  const absolute = join(appRoot, ".factory", "captures", role, task.id)
  rmSync(absolute, { recursive: true, force: true })
  mkdirSync(absolute, { recursive: true })

  const { pin, root, capture } = task.target
  const treeish = root === "." ? pin : `${pin}:${root}`
  // Scratch files live INSIDE the capture directory so nothing survives beside it; they are
  // removed before the function returns.
  const tar = join(absolute, ".b4-archive.tar")
  execFileSync(
    "git",
    ["-C", repo, "archive", "--format=tar", "-o", tar, treeish, "--", ...capture.include],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 },
  )
  try {
    execFileSync("tar", ["-xf", tar, "-C", absolute], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 60_000,
    })
  } finally {
    rmSync(tar, { force: true })
  }

  if (task.defectPatch !== null) {
    const patch = join(absolute, ".b4-defect.patch")
    writeFileSync(patch, task.defectPatch)
    try {
      const applied = spawnSync("git", ["apply", patch], {
        cwd: absolute,
        encoding: "utf8",
        timeout: 60_000,
      })
      if (applied.status !== 0)
        throw new Error(`Task ${task.id}: defect patch did not apply to ${pin}:\n${applied.stderr}`)
    } finally {
      rmSync(patch, { force: true })
    }
  }
  return { directory, absolute }
}
