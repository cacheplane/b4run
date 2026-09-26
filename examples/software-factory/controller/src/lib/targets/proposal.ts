import { execFileSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
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
 * is written to be formatted. `root` is the controller's root; a test names another.
 */
export function formatManifest(json: string, root: string = appRoot): string {
  try {
    return execFileSync(
      join(root, "node_modules", ".bin", "biome"),
      ["format", "--stdin-file-path=target.json"],
      {
        cwd: root,
        input: json,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "inherit"],
        timeout: 60_000,
      },
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("the controller's Biome is not installed: run pnpm install")
    throw error
  }
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

/**
 * Write every proposal that changes its file; returns the paths written. Refused, before
 * anything is written, when a file changed since the proposal read it or its directory is a
 * symbolic link. Each file is written to a temporary file beside it and renamed into place, so
 * a reader never sees half of one.
 */
export function writeProposal(files: readonly FileProposal[]): string[] {
  const changing = files.filter((file) => file.before !== file.after)
  for (const file of changing) {
    const directory = dirname(file.path)
    if (lstatIfPresent(directory)?.isSymbolicLink())
      throw new Error(
        `${directory} is a symbolic link: a proposal is written only into a real directory`,
      )
    if (readIfPresent(file.path) !== file.before)
      throw new Error(`${file.path} changed since the proposal was made: run the command again`)
  }
  const written: string[] = []
  for (const file of changing) {
    mkdirSync(dirname(file.path), { recursive: true })
    const temporary = join(dirname(file.path), `.${basename(file.path)}.${process.pid}.tmp`)
    writeFileSync(temporary, file.after, { flag: "wx" })
    try {
      renameSync(temporary, file.path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    written.push(file.path)
  }
  return written
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
