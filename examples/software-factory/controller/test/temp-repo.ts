import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { repositoryRoot } from "../src/lib/targets/catalog.ts"

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()

/**
 * The repository the controller under test pins against (this one) and a commit it holds:
 * a work order's pin must be a commit the controller can find (`ensurePin` runs before a
 * drafter manifest is written), and an invented sha would send it fetching from origin.
 * The catalog's targets pin commits of this repository too, so the repository root itself
 * is never redirected for a whole test.
 */
export function repositoryHead(): { root: string; pin: string } {
  const root = repositoryRoot()
  return { root, pin: git(root, "rev-parse", "HEAD") }
}

/** An empty repository, with no commit at all: nothing pins to it. */
export function createEmptyRepo(prefix = "factory-repo-empty-"): string {
  const root = mkdtempSync(isAbsolute(prefix) ? prefix : join(tmpdir(), prefix))
  git(root, "init", "-q")
  return root
}
