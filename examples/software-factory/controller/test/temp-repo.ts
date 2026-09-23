import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import {
  loadTargetIds,
  repositoryRoot,
  TargetSchema,
  targetsDir,
} from "../src/lib/targets/catalog.ts"

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

/**
 * The commit the shipped targets are prepared at: their default pin, and the one pin every
 * shipped target holds an image for. A work order that drafts against a shipped target must
 * be pinned here (`parseDraft` looks the target up at the work order's pin, and HEAD has no
 * image); both targets pin the same commit, which this asserts.
 */
export function shippedPin(): string {
  const pins = new Set(
    loadTargetIds().map(
      (id) =>
        TargetSchema.parse(JSON.parse(readFileSync(join(targetsDir, id, "target.json"), "utf8")))
          .pin,
    ),
  )
  const [pin, ...others] = pins
  if (pin === undefined || others.length > 0)
    throw new Error(`the shipped targets do not share one pin: ${[...pins].join(", ")}`)
  return pin
}
