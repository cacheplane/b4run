import { createHash } from "node:crypto"

/**
 * Git's object ids, computed here rather than trusted from GitHub (rung 4 spec §6.3): the
 * delivery worker knows the blob and tree ids the approved change must produce before it
 * writes anything, and refuses any answer that disagrees. SHA-1 object format only, which is
 * what `cacheplane/b4run` uses.
 */

/** A git object id: 40 lowercase hex digits. */
export const OBJECT_ID = /^[0-9a-f]{40}$/

/** `git hash-object` of `text` as UTF-8: `sha1("blob <length>\0" + bytes)`. */
export function blobId(text: string): string {
  const bytes = Buffer.from(text, "utf8")
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

export type GitEntryType = "blob" | "tree" | "commit"

/** One entry of a tree as GitHub's non-recursive `git/trees` lists it. */
export interface GitTreeEntry {
  /** The entry's own name, one path segment. */
  readonly name: string
  /** As GitHub reports it: `100644`, `100755`, `120000`, `160000` or `040000`. */
  readonly mode: string
  readonly type: GitEntryType
  readonly sha: string
}

const MODES: Readonly<Record<string, GitEntryType>> = {
  "100644": "blob",
  "100755": "blob",
  "120000": "blob",
  "160000": "commit",
  "040000": "tree",
}

/** The mode as git writes it inside a tree object: no leading zero. */
const encodedMode = (mode: string) => (mode === "040000" ? "40000" : mode)

/**
 * Git's tree order: by name as bytes, with a tree compared as if its name ended in `/`.
 * Not `localeCompare`, which would order `a-b` and `a/` differently from git.
 */
function treeOrder(a: GitTreeEntry, b: GitTreeEntry): number {
  const key = (entry: GitTreeEntry) =>
    Buffer.from(entry.type === "tree" ? `${entry.name}/` : entry.name, "utf8")
  return Buffer.compare(key(a), key(b))
}

/** `git mktree` of `entries`: the id of the tree object holding exactly them. */
export function treeId(entries: readonly GitTreeEntry[]): string {
  const names = new Set<string>()
  const parts: Buffer[] = []
  for (const entry of [...entries].sort(treeOrder)) {
    if (MODES[entry.mode] !== entry.type)
      throw new Error(`tree entry ${entry.name} has mode ${entry.mode} for a ${entry.type}`)
    if (entry.name === "" || entry.name.includes("/") || entry.name.includes("\0"))
      throw new Error(`tree entry name ${JSON.stringify(entry.name)} is not one path segment`)
    if (names.has(entry.name)) throw new Error(`tree lists ${entry.name} twice`)
    if (!OBJECT_ID.test(entry.sha)) throw new Error(`tree entry ${entry.name} has id ${entry.sha}`)
    names.add(entry.name)
    parts.push(
      Buffer.from(`${encodedMode(entry.mode)} ${entry.name}\0`, "utf8"),
      Buffer.from(entry.sha, "hex"),
    )
  }
  const body = Buffer.concat(parts)
  return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex")
}

/** The directories a set of repository paths passes through, root (`""`) first, then by depth. */
export function directoriesOf(paths: readonly string[]): string[] {
  const directories = new Set<string>([""])
  for (const path of paths) {
    const segments = path.split("/")
    for (let depth = 1; depth < segments.length; depth += 1)
      directories.add(segments.slice(0, depth).join("/"))
  }
  return [...directories].sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : 1))
}
const depthOf = (directory: string) => (directory === "" ? 0 : directory.split("/").length)
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** What the pin holds at one changed path: the entry the change replaces. */
export interface PinEntry {
  readonly mode: string
  readonly sha: string
}

/**
 * Every directory listing the changed paths pass through, read one directory at a time
 * (non-recursive, so a large repository never meets the recursive listing's truncation), and
 * the pin's entry at each changed path. A path whose directory is missing, or whose last
 * segment is missing or is not a regular file, is reported, never guessed: the approved
 * change cannot be stated as a change to the pin.
 */
export async function readPinListings(
  rootTree: string,
  paths: readonly string[],
  readTree: (sha: string) => Promise<readonly GitTreeEntry[]>,
): Promise<
  | {
      readonly ok: true
      readonly listings: ReadonlyMap<string, readonly GitTreeEntry[]>
      readonly entries: ReadonlyMap<string, PinEntry>
    }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  const listings = new Map<string, readonly GitTreeEntry[]>()
  const problems: string[] = []
  for (const directory of directoriesOf(paths)) {
    let sha: string
    if (directory === "") sha = rootTree
    else {
      const parent = listings.get(parentOf(directory))
      if (parent === undefined) continue // its parent was already reported
      const entry = parent.find((e) => e.name === nameOf(directory))
      if (entry === undefined || entry.type !== "tree") {
        problems.push(`${directory} is not a directory at the pin`)
        continue
      }
      sha = entry.sha
    }
    listings.set(directory, await readTree(sha))
  }
  const entries = new Map<string, PinEntry>()
  for (const path of paths) {
    const listing = listings.get(parentOf(path))
    if (listing === undefined) continue
    const entry = listing.find((e) => e.name === nameOf(path))
    if (entry === undefined) problems.push(`${path} does not exist at the pin`)
    else if (entry.mode !== "100644" && entry.mode !== "100755")
      problems.push(`${path} is not a regular file at the pin (mode ${entry.mode})`)
    else entries.set(path, { mode: entry.mode, sha: entry.sha })
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, listings, entries }
}

/**
 * The root tree id the approved change must produce: the pin's listings with each changed
 * path's blob replaced, recomputed bottom-up. Modes are kept from the pin; nothing is added
 * or removed, which is exactly what a candidate can do (it cannot add a file).
 */
export function changedTreeId(
  listings: ReadonlyMap<string, readonly GitTreeEntry[]>,
  blobs: ReadonlyMap<string, string>,
): string {
  const replaced = new Map<string, string>()
  for (const [path, sha] of blobs) replaced.set(path, sha)
  const directories = [...listings.keys()].sort((a, b) => depthOf(b) - depthOf(a))
  for (const directory of directories) {
    const listing = listings.get(directory) as readonly GitTreeEntry[]
    const entries = listing.map((entry) => {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`
      const sha = replaced.get(path)
      return sha === undefined ? entry : { ...entry, sha }
    })
    replaced.set(directory, treeId(entries))
  }
  const root = replaced.get("")
  if (root === undefined) throw new Error("no root listing")
  return root
}
