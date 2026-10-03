import { execFileSync } from "node:child_process"
import { posix } from "node:path"
import type { WorkOrderRow } from "../domain/work-order.js"
import { commitExists, loadTaskRecipe, repositoryRoot } from "../targets/catalog.js"
import type { DiffBase, PinnedFile } from "./operator-review.js"

/** The first line of an error, for a reason shown beside a whole file. */
const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n", 1)[0] ?? ""

/**
 * The export review's diff base: the target's files at the work order's pin (the target's own
 * pin for a catalog work order, which records none), read from the object store `create`
 * uses (`FACTORY_REPO_ROOT`, else this checkout). Loading the task's target ensures its pin as
 * the catalog always does, as `create` does: a pin the store lacks is fetched from origin,
 * unless `FACTORY_NO_FETCH=1`. A pin that still cannot be read makes every file `unavailable`,
 * with the reason, and the review shows it whole. Each path is read once, when the review
 * renders it.
 */
export function pinDiffBase(row: WorkOrderRow): DiffBase {
  let repo: string
  let pin: string
  let root: string
  let defect: boolean
  try {
    const task = loadTaskRecipe(row.taskId)
    pin = row.pin ?? task.target.pin
    root = task.target.root
    defect = task.defectPatch !== null
    repo = repositoryRoot()
  } catch (error) {
    const reason = `the work order's target could not be loaded (${firstLine(error)})`
    return { label: "the pin", read: () => ({ kind: "unavailable", reason }) }
  }
  const label = `pin ${pin.slice(0, 12)}`
  if (!commitExists(repo, pin)) {
    const reason = `${label} is not in the object store at ${repo}`
    return { label, read: () => ({ kind: "unavailable", reason }) }
  }
  const git = (...args: string[]): Buffer =>
    execFileSync("git", ["-C", repo, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  return {
    label,
    note: defect
      ? `Diffs are against the target's files at ${pin} in ${repo}. The builder's baseline was that commit with the task's defect.patch applied, so each diff also shows the defect being undone.`
      : `Diffs are against the target's files at ${pin} in ${repo}.`,
    read(path): PinnedFile {
      const gitPath = root === "." || root === "" ? path : posix.join(root, path)
      try {
        // `ls-tree` answers "no such path at this commit" with empty output, which `cat-file`
        // would report as the same failure as an unreadable store.
        const entry = git("ls-tree", pin, "--", gitPath).toString("utf8").trim()
        if (entry === "") return { kind: "absent" }
        if (!/^\d+ blob /.test(entry))
          return { kind: "unavailable", reason: `${gitPath} at ${label} is not a file` }
        return { kind: "bytes", bytes: git("cat-file", "blob", `${pin}:${gitPath}`) }
      } catch (error) {
        return {
          kind: "unavailable",
          reason: `${gitPath} could not be read at ${label} (${firstLine(error)})`,
        }
      }
    },
  }
}
