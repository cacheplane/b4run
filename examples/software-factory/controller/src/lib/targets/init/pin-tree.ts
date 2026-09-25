import { execFileSync } from "node:child_process"

/**
 * The repository at one commit, read from the object store and never from the working tree:
 * what `target:init` derives a target from. A target is an oracle input, and an edit a person
 * has not committed must not reach it. Every path is relative to the repository's top level,
 * whatever directory inside it `repositoryRoot` names.
 */
export interface PinTree {
  readonly repositoryRoot: string
  /** The full sha of the commit the pin resolved to. */
  readonly pin: string
  /**
   * A regular file's text at the pin; undefined when the pin holds nothing there. Throws for a
   * directory, a symlink or a submodule: none of them is a file's text.
   */
  read(path: string): string | undefined
  /** What the pin holds at `path` ("" is the root, a `dir`); undefined when it holds nothing. */
  kind(path: string): EntryKind | undefined
  /** The immediate entries of `dir` ("" is the root), sorted by name. */
  children(dir: string): TreeEntry[]
  /** Every non-directory entry under `path` ("" is the root) or `path` itself, sorted. */
  files(path: string): TreeFile[]
}

export type EntryKind = "file" | "dir" | "link" | "submodule"

export interface TreeEntry {
  readonly name: string
  readonly kind: EntryKind
}

export interface TreeFile {
  readonly path: string
  readonly bytes: number
  /** Git's mode: `100644`, `100755`, `120000` (a symlink) or `160000` (a submodule). */
  readonly mode: string
}

interface Entry {
  readonly kind: EntryKind
  readonly mode: string
  readonly object: string
  readonly bytes: number
}

const MAX_BUFFER = 256 * 1024 * 1024
const byName = <T extends { readonly name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0
const clean = (path: string) => path.replace(/\/+$/, "")
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")))
const gitError = (error: unknown) => {
  const stderr = (error as { stderr?: unknown }).stderr
  const text = typeof stderr === "string" ? stderr.trim() : ""
  return text.length > 0 ? text : String(error)
}

/**
 * The pin as one listing: `git ls-tree -r -t --full-tree` runs once, and `kind`, `children` and
 * `files` answer from it, so a git failure is reported once, here, and never read as absence.
 * Only `read` goes back to the object store, by the blob's own object id.
 */
export function gitPinTree(repositoryRoot: string, pin: string): PinTree {
  const git = (args: readonly string[]) =>
    execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
  let sha: string
  try {
    sha = git(["rev-parse", "--verify", "--end-of-options", `${pin}^{commit}`]).trim()
  } catch (error) {
    throw new Error(`${pin} is not a commit in ${repositoryRoot}: ${gitError(error)}`)
  }
  let listing: string
  try {
    listing = git(["ls-tree", "-r", "-t", "-z", "-l", "--full-tree", sha])
  } catch (error) {
    throw new Error(`Cannot list ${repositoryRoot} at ${sha}: ${gitError(error)}`)
  }
  const entries = new Map<string, Entry>([
    ["", { kind: "dir", mode: "040000", object: "", bytes: 0 }],
  ])
  const children = new Map<string, TreeEntry[]>()
  /** `git ls-tree -z -l` records: `<mode> <type> <object> <size>\t<path>`. */
  for (const record of listing.split("\0")) {
    if (record.length === 0) continue
    const tab = record.indexOf("\t")
    const [mode, type, object, size] = record.slice(0, tab).trim().split(/\s+/) as [
      string,
      string,
      string,
      string,
    ]
    const path = record.slice(tab + 1)
    const kind: EntryKind =
      type === "tree"
        ? "dir"
        : type === "commit"
          ? "submodule"
          : mode === "120000"
            ? "link"
            : "file"
    entries.set(path, { kind, mode, object, bytes: size === "-" ? 0 : Number(size) })
    const parent = parentOf(path)
    const siblings = children.get(parent) ?? []
    siblings.push({ name: path.slice(path.lastIndexOf("/") + 1), kind })
    children.set(parent, siblings)
  }
  for (const list of children.values()) list.sort(byName)
  const files = [...entries]
    .filter(([, entry]) => entry.kind !== "dir")
    .map(([path, entry]) => ({ path, bytes: entry.bytes, mode: entry.mode }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    repositoryRoot,
    pin: sha,
    kind: (path) => entries.get(clean(path))?.kind,
    read(path) {
      const entry = entries.get(clean(path))
      if (entry === undefined) return undefined
      if (entry.kind !== "file")
        throw new Error(
          `${path} at ${sha} is a ${entry.kind}, not a file: target:init reads files only`,
        )
      try {
        return git(["cat-file", "blob", entry.object])
      } catch (error) {
        throw new Error(`Cannot read ${path} at ${sha}: ${gitError(error)}`)
      }
    },
    children: (dir) => [...(children.get(clean(dir)) ?? [])],
    files(path) {
      const at = clean(path)
      if (at === "") return [...files]
      return files.filter((file) => file.path === at || file.path.startsWith(`${at}/`))
    },
  }
}
