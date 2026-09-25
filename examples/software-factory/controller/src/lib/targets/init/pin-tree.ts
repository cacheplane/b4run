import { execFileSync } from "node:child_process"

/**
 * The repository at one commit, read from the object store and never from the working tree:
 * what `target:init` derives a target from. A target is an oracle input, and an edit a person
 * has not committed must not reach it.
 */
export interface PinTree {
  readonly repositoryRoot: string
  readonly pin: string
  /** A file's text at the pin; undefined when the pin holds no file there. */
  read(path: string): string | undefined
  kind(path: string): "file" | "dir" | undefined
  /** The immediate entries of `dir` ("" is the root), sorted by name. */
  children(dir: string): TreeEntry[]
  /** Every file under `path` (or `path` itself), repository-relative, sorted. */
  files(path: string): TreeFile[]
}

export interface TreeEntry {
  readonly name: string
  readonly kind: "file" | "dir" | "link" | "submodule"
}

export interface TreeFile {
  readonly path: string
  readonly bytes: number
  /** Git's mode: `100644`, `100755`, `120000` (a symlink) or `160000` (a submodule). */
  readonly mode: string
}

const MAX_BUFFER = 256 * 1024 * 1024
const byName = <T extends { readonly name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0

export function gitPinTree(repositoryRoot: string, pin: string): PinTree {
  const git = (args: readonly string[]) =>
    execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
  try {
    git(["cat-file", "-e", `${pin}^{commit}`])
  } catch {
    throw new Error(`${pin} is not a commit in ${repositoryRoot}`)
  }
  /** `git ls-tree -z [-l]` records: `<mode> <type> <object>[ <size>]\t<path>`. */
  const lsTree = (args: readonly string[]) =>
    git(["ls-tree", "-z", ...args])
      .split("\0")
      .filter((record) => record.length > 0)
      .map((record) => {
        const tab = record.indexOf("\t")
        const [mode, type, , size] = record.slice(0, tab).trim().split(/\s+/)
        return { mode: mode as string, type: type as string, size, path: record.slice(tab + 1) }
      })
  const kind = (path: string): "file" | "dir" | undefined => {
    let type: string
    try {
      type = git(["cat-file", "-t", `${pin}:${path}`]).trim()
    } catch {
      return undefined
    }
    return type === "tree" ? "dir" : type === "blob" ? "file" : undefined
  }
  return {
    repositoryRoot,
    pin,
    kind,
    read(path) {
      if (kind(path) !== "file") return undefined
      return git(["cat-file", "blob", `${pin}:${path}`])
    },
    children(dir) {
      return lsTree(dir === "" ? [pin] : [pin, "--", `${dir}/`])
        .map((record) => ({
          name: record.path.slice(record.path.lastIndexOf("/") + 1),
          kind:
            record.type === "tree"
              ? ("dir" as const)
              : record.type === "commit"
                ? ("submodule" as const)
                : record.mode === "120000"
                  ? ("link" as const)
                  : ("file" as const),
        }))
        .sort(byName)
    },
    files(path) {
      return lsTree(["-r", "-l", pin, "--", path])
        .map((record) => ({
          path: record.path,
          bytes: record.size === undefined || record.size === "-" ? 0 : Number(record.size),
          mode: record.mode,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
  }
}
