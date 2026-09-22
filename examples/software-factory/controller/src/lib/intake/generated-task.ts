import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import type { ParsedDraft } from "./draft.js"

export interface GeneratedTask {
  readonly directory: string
  readonly digest: string
  /** Every file written, relative to `directory`, sorted: the set the digest is over. */
  readonly files: readonly string[]
}

/** A file's bytes, keyed by its `directory`-relative forward-slash path. */
type FileSet = ReadonlyMap<string, Buffer>

/** The exact bytes a generated task directory holds, before anything touches disk. */
function planFiles(draft: ParsedDraft, issueText: string): FileSet {
  const { id, target, allowedSourcePaths, immutablePaths } = draft.manifest
  const files = new Map<string, Buffer>()
  const text = (path: string, content: string) => files.set(path, Buffer.from(content, "utf8"))
  // Keys in schema order, so two runs over the same draft write the same bytes.
  text(
    "task.json",
    `${JSON.stringify({ id, target, allowedSourcePaths, immutablePaths }, null, 2)}\n`,
  )
  text("checks.json", `${JSON.stringify(draft.checks, null, 2)}\n`)
  text("spec.md", draft.specText)
  text("issue.md", issueText)
  const check = draft.checks.independent.file
  const content = draft.files.get(check)
  if (content === undefined) throw new Error(`draft check ${check} has no content`)
  text(check, content)
  return files
}

/**
 * sha256 over a domain tag and then every file in sorted path order, each as
 * `path NUL bytes NUL`: the path is part of the hash, so moving a byte-identical file
 * elsewhere changes the digest, and the separators keep a path from running into the bytes
 * that follow it. The tag keeps this digest from colliding with any other sha256 the factory
 * derives (see `domain/digest.ts`).
 */
function digestFiles(files: FileSet): string {
  const hash = createHash("sha256").update("b4-factory-task-v1\0")
  const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [path, bytes] of sorted) hash.update(path).update("\0").update(bytes).update("\0")
  return hash.digest("hex")
}

/**
 * Materialise a parsed draft as a task directory the catalog can load, and digest it. The
 * digest is over the exact files a builder or verifier can see (sorted path + bytes), so
 * `approve-intake --digest` binds what the person read to what runs. Written to a temp
 * sibling and renamed into place, so a crash cannot leave a half-written task loadable,
 * and a previous attempt's directory is replaced wholesale.
 */
export function writeGeneratedTask(
  generatedTasksDir: string,
  draft: ParsedDraft,
  input: { readonly issueText: string },
): GeneratedTask {
  const files = planFiles(draft, input.issueText)
  const directory = join(generatedTasksDir, draft.manifest.id)
  // A leading dot keeps the sibling out of `loadTaskIds`: it is not a catalog id.
  const staging = join(
    generatedTasksDir,
    `.${draft.manifest.id}.tmp-${randomBytes(8).toString("hex")}`,
  )
  mkdirSync(generatedTasksDir, { recursive: true })
  try {
    for (const [path, bytes] of files) {
      const absolute = join(staging, path)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, bytes)
    }
    // Between this removal and the rename there is no task at `directory`; a concurrent
    // `loadTask` sees "Unknown task", never a partial one. The window is two syscalls wide.
    rmSync(directory, { recursive: true, force: true })
    renameSync(staging, directory)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return { directory, digest: digestFiles(files), files: [...files.keys()].sort() }
}

/**
 * Every regular file under `directory`, recursively, keyed by forward-slash relative path.
 * Anything else (a symlink, a socket, a device) is refused rather than skipped: the digest
 * must fail closed on an entry it cannot account for, or something added after approval
 * would be invisible to the gate.
 */
function readTree(directory: string): FileSet {
  const files = new Map<string, Buffer>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      const path = relative(directory, absolute).split(sep).join("/")
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.set(path, readFileSync(absolute))
      else throw new Error(`generated task contains a non-regular file: ${path}`)
    }
  }
  walk(directory)
  return files
}

/** Recompute the digest from disk, for the gate. Same file set rule: every regular file under the directory, sorted. */
export function digestGeneratedTask(directory: string): string {
  return digestFiles(readTree(directory))
}
