import { readFileSync } from "node:fs"
import { z } from "zod"

/**
 * The one statement of the factory's CI guard, shared by the controller and the workflow
 * contract test (`scripts/release/test/workflow-contracts.test.mjs`, which reads the JSON):
 * the branch prefix every guarded job skips, the app's bot login every guarded job skips, and
 * the paths a delivery may never change because the guard lives in them (rung 4 spec §9).
 * `runFromBranchPaths` is the part of those that runs from the factory branch's own commit
 * (the Vercel build reads the pin's ignore script), so `main` must not have changed them
 * since the pin either: a pin older than the guard carries the unguarded script. The
 * workflows are not in it: a pull request runs `main`'s workflows at the merge commit, so
 * `main` changing `.github/**` since the pin is harmless (it changes about forty times a
 * month) and must not block delivery.
 * Read from disk, not imported: the contract test is plain Node and reads the same file.
 */
const guard = z
  .object({
    branchPrefix: z.literal("factory/"),
    botLogin: z.string().regex(/^[a-z0-9][a-z0-9-]*\[bot\]$/),
    protectedPaths: z.array(z.string().min(1)).min(1),
    runFromBranchPaths: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .parse(JSON.parse(readFileSync(new URL("./guard.json", import.meta.url), "utf8")))

export const FACTORY_BRANCH_PREFIX: string = guard.branchPrefix
export const FACTORY_BOT_LOGIN: string = guard.botLogin
export const DELIVERY_PROTECTED_PATHS: readonly string[] = Object.freeze([...guard.protectedPaths])
export const RUN_FROM_BRANCH_PATHS: readonly string[] = Object.freeze([...guard.runFromBranchPaths])

/** A workspace path as the repository names it: under the target's root. */
export function repositoryPath(pathPrefix: string, path: string): string {
  return pathPrefix === "." ? path : `${pathPrefix}/${path}`
}

const matches = (entries: readonly string[], path: string) =>
  entries.some((entry) =>
    entry.endsWith("/**")
      ? path === entry.slice(0, -3) || path.startsWith(entry.slice(0, -2))
      : path === entry,
  )

/** Is `path` (a repository path) one a delivery may never change, or under one? */
export function isProtectedPath(path: string): boolean {
  return matches(DELIVERY_PROTECTED_PATHS, path)
}

/** Is `path` one the branch's own commit runs, which `main` must not have changed since the pin? */
export function isRunFromBranchPath(path: string): boolean {
  return matches(RUN_FROM_BRANCH_PATHS, path)
}

/** The repository paths among `paths` a delivery may never change, sorted. */
export function protectedPathsIn(paths: Iterable<string>): string[] {
  return [...new Set([...paths].filter(isProtectedPath))].sort()
}
