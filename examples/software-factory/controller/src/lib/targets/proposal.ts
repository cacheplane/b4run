import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { createTwoFilesPatch } from "diff"
import { appRoot } from "./catalog.js"

/**
 * A file `target:init` or `target:measure` would write. Nothing is written until the person
 * asks (`--write`); the diff of `before` and `after` is the proposal, and `git diff` after a
 * write is the review.
 */
export interface FileProposal {
  /** Absolute. */
  readonly path: string
  /** What is on disk now; null when there is no such file. */
  readonly before: string | null
  readonly after: string
}

export function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/**
 * `json` formatted as the checked-in target files are: the controller's own Biome (never
 * `npx`, which may resolve another version) with its own configuration, over stdin, so nothing
 * is written to be formatted.
 */
export function formatManifest(json: string): string {
  return execFileSync(
    join(appRoot, "node_modules", ".bin", "biome"),
    ["format", "--stdin-file-path=target.json"],
    {
      cwd: appRoot,
      input: json,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
      timeout: 60_000,
    },
  )
}

/** A unified diff of every proposal that changes its file, named relative to `base`. */
export function renderDiff(files: readonly FileProposal[], base: string): string {
  return files
    .filter((file) => file.before !== file.after)
    .map((file) => {
      const name = relative(base, file.path)
      return createTwoFilesPatch(
        file.before === null ? "/dev/null" : `a/${name}`,
        `b/${name}`,
        file.before ?? "",
        file.after,
        undefined,
        undefined,
        { context: 3 },
      )
    })
    .join("")
}

/** Write every proposal that changes its file; returns the paths written. */
export function writeProposal(files: readonly FileProposal[]): string[] {
  const written: string[] = []
  for (const file of files) {
    if (file.before === file.after) continue
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.after)
    written.push(file.path)
  }
  return written
}
