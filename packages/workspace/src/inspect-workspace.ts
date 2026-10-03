import type { WorkspaceFs } from "@b4run/sdk"
import {
  isCanonicalWorkspaceRoot,
  isWorkspaceReadLimitError,
  WorkspaceInspectionError,
  type WorkspaceInspectionErrorCode,
} from "./inspection-errors.js"
import type { WorkspaceReadSource } from "./sandbox-types.js"
import type { BackendContext, FilesystemBackend } from "./types.js"

export interface InspectWorkspaceOptions {
  readonly signal?: AbortSignal
  /** Maximum entries, including directories and excluded root entries. Default: 10,000. */
  readonly maxEntries?: number
  /** Default: 2 MiB. */
  readonly maxFileBytes?: number
  /** Default: 16 MiB. */
  readonly maxTotalBytes?: number
  /** Root leaf names whose directory subtrees may be omitted. Files and links fail. */
  readonly excludeRootDirectories?: readonly string[]
  /** Required root symlinks and their exact, unnormalized readlink targets. */
  readonly expectedRootSymlinks?: Readonly<Record<string, string>>
  /**
   * A relative directory (`draft`, `a/b`) under the workspace root at which the
   * inspection STARTS. Nothing outside it is walked or read, every returned key
   * is relative to it, and `excludeRootDirectories` and `expectedRootSymlinks`
   * apply at it. Every segment is lstat'ed and must be a real directory: a root
   * that names nothing, or passes through or ends at a file or a symlink, is a
   * `root_missing` refusal naming the root and the segment, never a read that
   * follows a link out of the workspace. Every segment is lstat'ed again after
   * the read, and one that changed meanwhile is a `changed` refusal; a swap made
   * and undone between the two checks is not detected (see `recheckRoot`). Needs a
   * sandbox handle or workspace reader (an absolute root).
   */
  readonly root?: string
}

export interface WorkspaceInspection {
  /** Complete relative-path text inventory outside explicitly omitted roots. */
  readonly files: Readonly<Record<string, string>>
  /** Validated root symlinks, recorded separately from files. */
  readonly symlinks: Readonly<Record<string, string>>
  readonly totalBytes: number
  /** Inspected entries, excluding the root itself. */
  readonly entries: number
}

type Metadata = Awaited<ReturnType<NonNullable<WorkspaceFs["stat"]>>>
interface Plan {
  readonly maxEntries: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly prune: readonly string[]
}
interface Reader {
  stat(path: string): Promise<Metadata>
  list(path: string): Promise<readonly string[]>
  read(path: string, maxBytes: number): Promise<Uint8Array>
  /** Batch-capable readers load the whole tree and its files here, once. */
  prepare?(plan: Plan): Promise<void>
}

function fail(
  code: WorkspaceInspectionErrorCode,
  message: string,
  options?: ErrorOptions,
): WorkspaceInspectionError {
  return new WorkspaceInspectionError(code, message, {}, options)
}

/**
 * A read-limit refusal for a file whose recorded size fit its request means the
 * file grew after it was measured: the workspace changed, it did not break a
 * limit. The message names the file relative to the inspected root (`relative`
 * maps the backend's path back), never the backend's own absolute path, which is
 * kept only as the cause. Anything else the backend threw is its own failure,
 * left untyped.
 */
function grown(error: unknown, relative: (path: string) => string | undefined): unknown {
  if (!isWorkspaceReadLimitError(error)) return error
  const name = relative(error.path)
  return fail(
    "changed",
    `Workspace changed during inspection: ${name === undefined ? "a file" : name} grew after it was measured`,
    { cause: error },
  )
}

/**
 * Serve `list` and `stat` from one `walkTree` and the file reads from one
 * `readBinaryFiles`, so an inspection costs a few backend calls instead of one
 * per entry. The walk is only a cache for the policy loop in
 * {@link inspectWorkspace}, which applies exactly the checks it applies to
 * per-entry calls. Every walked name is validated here, and an entry whose
 * parent is not a walked directory is refused.
 *
 * Files are prefetched with `maxBytes` set to their walked size, so a file that
 * grew between the walk and the read is refused (`changed`) rather than read past
 * its recorded size. Prefetch is skipped when the eligible files together exceed
 * the byte budget; the loop then fails on its own limits exactly as before.
 */
function batched(
  fs: Required<Pick<FilesystemBackend, "walkTree" | "readBinaryFiles">>,
  single: Reader,
  absolute: (path: string) => string,
  ctx: BackendContext,
): Reader {
  let tree: Map<string, Metadata> | undefined
  const children = new Map<string, string[]>()
  const bytes = new Map<string, Uint8Array>()
  return {
    stat: (path) => {
      const entry = path ? tree?.get(path) : undefined
      if (entry) return Promise.resolve(entry)
      if (tree && path) throw fail("changed", `Workspace changed during inspection: ${path}`)
      return single.stat(path)
    },
    list: (path) => {
      if (!tree) return single.list(path)
      const names = children.get(path)
      if (!names) throw fail("changed", `Workspace changed during inspection: ${path}`)
      return Promise.resolve(names)
    },
    read: (path, maxBytes) => {
      const prefetched = bytes.get(path)
      return prefetched ? Promise.resolve(prefetched) : single.read(path, maxBytes)
    },
    async prepare(plan) {
      const walked = await fs.walkTree(absolute(""), ctx, {
        maxEntries: plan.maxEntries,
        prune: plan.prune,
      })
      ctx.signal.throwIfAborted()
      if (walked.length > plan.maxEntries) throw fail("refused", "Workspace entries limit exceeded")
      const found = new Map<string, Metadata>()
      children.set("", [])
      for (const entry of walked) {
        const segments = entry.path.split("/")
        for (const segment of segments) leaf(segment)
        if (found.has(entry.path))
          throw fail("refused", `Workspace duplicate entry name: ${entry.path}`)
        found.set(entry.path, {
          kind: entry.kind,
          size: entry.size,
          executable: entry.executable,
          ...(entry.target !== undefined ? { target: entry.target } : {}),
        } as Metadata)
        if (entry.kind === "directory") children.set(entry.path, [])
      }
      for (const entry of walked) {
        const cut = entry.path.lastIndexOf("/")
        const siblings = children.get(cut < 0 ? "" : entry.path.slice(0, cut))
        if (!siblings)
          throw fail("refused", `Invalid workspace entry name: ${JSON.stringify(entry.path)}`)
        siblings.push(entry.path.slice(cut + 1))
      }
      const files = walked.filter(
        (entry) =>
          entry.kind === "file" &&
          entry.executable === false &&
          Number.isSafeInteger(entry.size) &&
          entry.size >= 0 &&
          entry.size <= plan.maxFileBytes,
      )
      const planned = files.reduce((total, entry) => total + entry.size, 0)
      if (files.length && planned <= plan.maxTotalBytes) {
        let read: Awaited<ReturnType<typeof fs.readBinaryFiles>>
        try {
          read = await fs.readBinaryFiles(
            files.map((entry) => ({ path: absolute(entry.path), maxBytes: entry.size })),
            ctx,
          )
        } catch (error) {
          throw grown(error, (path) => files.find((entry) => absolute(entry.path) === path)?.path)
        }
        if (read.length !== files.length) throw new Error("Invalid batch read response")
        files.forEach((entry, index) => {
          bytes.set(entry.path, read[index] as Uint8Array)
        })
      }
      tree = found
    },
  }
}

/**
 * `base`, when set, is the absolute directory `atRoot` established under the
 * workspace root: paths are built under it, while every backend call still
 * reports the WORKSPACE root as its context, which is the jail a backend checks.
 */
function reader(
  source: WorkspaceFs | WorkspaceReadSource,
  signal: AbortSignal,
  base?: string,
): Reader {
  if ("filesystem" in source) {
    const fs = source.filesystem
    const stat = fs.lstat?.bind(fs)
    const read = fs.readBinaryFile?.bind(fs)
    if (!stat) throw fail("invalid_options", "Workspace inspection requires leaf metadata (lstat)")
    if (!read) throw fail("invalid_options", "Workspace inspection requires binary reads")
    const workspace = source.workspaceRoot.replace(/\/$/, "")
    if (
      !source.workspaceRoot.startsWith("/") ||
      /[\\\0]/.test(workspace) ||
      workspace.split("/").some((part) => part === "." || part === "..")
    ) {
      throw fail(
        "invalid_options",
        "Workspace inspection requires an absolute canonical workspace root",
      )
    }
    const root = base ?? workspace
    const ctx = { workspaceRoot: source.workspaceRoot, signal }
    const absolute = (path: string) => (path ? `${root}/${path}` : root || "/")
    const single: Reader = {
      stat: (path) => stat(absolute(path), ctx),
      list: (path) => fs.listDir(absolute(path), ctx),
      read: (path, maxBytes) => read(absolute(path), ctx, { maxBytes }),
    }
    const walkTree = fs.walkTree?.bind(fs)
    const readBinaryFiles = fs.readBinaryFiles?.bind(fs)
    return walkTree && readBinaryFiles
      ? batched({ walkTree, readBinaryFiles }, single, absolute, ctx)
      : single
  }
  const stat = source.stat?.bind(source)
  if (!stat) throw fail("invalid_options", "Workspace inspection requires leaf metadata (stat)")
  if (!source.readBinaryFile)
    throw fail("invalid_options", "Workspace inspection requires binary reads")
  return {
    stat: (path) => stat(path || "."),
    list: (path) => source.listDir(path || "."),
    read: (path, maxBytes) => source.readBinaryFile(path, { maxBytes }),
  }
}

function leaf(name: string, code: WorkspaceInspectionErrorCode = "refused"): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw fail(code, `Invalid workspace entry name: ${JSON.stringify(name)}`)
  }
}

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw fail("invalid_options", `Invalid ${name} limit`)
  return value
}

/**
 * The absolute directory `root` names under the workspace root. EVERY segment is
 * lstat'ed and must be a directory: a symlink anywhere in `root` is refused, not
 * followed, because a provider's read-only reader need not jail paths (the Docker
 * reader does not) and a link at `draft` or at `draft/sub` would otherwise point
 * the whole inspection outside the workspace. A segment whose lstat fails is
 * `absent` only when its parent's listing proves the name is not there; any other
 * failure is the backend's own and is rethrown untyped. Only `lstat` is needed on
 * the path that succeeds, so a batch-only backend (whose per-entry `listDir` may
 * refuse) can still be re-rooted.
 */
async function atRoot(
  source: WorkspaceFs | WorkspaceReadSource,
  root: string,
  signal: AbortSignal,
): Promise<string> {
  if (!isCanonicalWorkspaceRoot(root))
    throw new WorkspaceInspectionError(
      "invalid_options",
      `Invalid workspace inspection root: ${JSON.stringify(root)}`,
      { root },
    )
  if (!("filesystem" in source))
    throw new WorkspaceInspectionError(
      "invalid_options",
      "Workspace inspection at a root needs a sandbox handle or workspace reader",
      { root },
    )
  const fs = source.filesystem
  const lstat = fs.lstat?.bind(fs)
  if (!lstat) throw fail("invalid_options", "Workspace inspection requires leaf metadata (lstat)")
  const ctx = { workspaceRoot: source.workspaceRoot, signal }
  let current = source.workspaceRoot.replace(/\/$/, "")
  const walked: string[] = []
  for (const segment of root.split("/")) {
    signal.throwIfAborted()
    const parent = current
    current = `${current}/${segment}`
    walked.push(segment)
    let metadata: Metadata
    try {
      metadata = await lstat(current, ctx)
    } catch (error) {
      signal.throwIfAborted()
      let names: readonly string[]
      try {
        names = await fs.listDir(parent || "/", ctx)
      } catch {
        throw error
      }
      if (names.includes(segment)) throw error
      throw new WorkspaceInspectionError(
        "root_missing",
        `Workspace root ${JSON.stringify(root)} is missing (${JSON.stringify(walked.join("/"))} does not exist)`,
        { root, kind: "absent" },
      )
    }
    signal.throwIfAborted()
    if (metadata.kind !== "directory")
      throw new WorkspaceInspectionError(
        "root_missing",
        `Workspace root ${JSON.stringify(root)} is not a directory (${JSON.stringify(walked.join("/"))} is a ${metadata.kind})`,
        { root, kind: "not_directory" },
      )
  }
  return current
}

/**
 * The root's segments again, after everything under it was read: each must still be
 * a directory. Without this, a process in the thread's session could swap a checked
 * segment for a symlink between `atRoot`'s lstat and the reads, and the answer would
 * describe wherever the link points. This narrows that race to the window between
 * the last read and this check, and a swap undone inside it is still possible: paths
 * are re-resolved per call, and no provider offers a descriptor-relative walk. What
 * such a swap could reach is bounded by the reader itself, a read-only, networkless
 * container over the workspace's own volume.
 */
async function recheckRoot(
  source: WorkspaceFs | WorkspaceReadSource,
  root: string,
  signal: AbortSignal,
): Promise<void> {
  if (!("filesystem" in source)) return
  const fs = source.filesystem
  const lstat = fs.lstat?.bind(fs)
  if (!lstat) return
  const ctx = { workspaceRoot: source.workspaceRoot, signal }
  let current = source.workspaceRoot.replace(/\/$/, "")
  const walked: string[] = []
  for (const segment of root.split("/")) {
    signal.throwIfAborted()
    current = `${current}/${segment}`
    walked.push(segment)
    let kind: string
    try {
      kind = (await lstat(current, ctx)).kind
    } catch (error) {
      signal.throwIfAborted()
      throw new WorkspaceInspectionError(
        "changed",
        `Workspace root ${JSON.stringify(root)} changed during inspection (${JSON.stringify(walked.join("/"))} is gone)`,
        { root },
        { cause: error },
      )
    }
    if (kind !== "directory")
      throw new WorkspaceInspectionError(
        "changed",
        `Workspace root ${JSON.stringify(root)} changed during inspection (${JSON.stringify(walked.join("/"))} is now a ${kind})`,
        { root },
      )
  }
}

/**
 * Inspect text without shell execution, preserving BOM bytes and rejecting unsupported
 * entries. Metadata and raw reads are mandatory. This is not an atomic snapshot:
 * callers must quiesce writers or revalidate before acting on the inventory.
 * Refusals are {@link WorkspaceInspectionError}s; a backend's own failure is
 * rethrown as it was thrown.
 */
export async function inspectWorkspace(
  source: WorkspaceFs | WorkspaceReadSource,
  options: InspectWorkspaceOptions = {},
): Promise<WorkspaceInspection> {
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const maxEntries = limit(options.maxEntries ?? 10_000, "entries")
  const maxFileBytes = limit(options.maxFileBytes ?? 2 * 1024 * 1024, "file bytes")
  const maxTotalBytes = limit(options.maxTotalBytes ?? 16 * 1024 * 1024, "total bytes")
  const excluded = new Set(options.excludeRootDirectories ?? [])
  const expected = new Map(Object.entries(options.expectedRootSymlinks ?? {}))
  for (const name of [...excluded, ...expected.keys()]) leaf(name, "invalid_options")
  for (const [name, target] of expected) {
    if (excluded.has(name)) throw fail("invalid_options", `Conflicting root policy: ${name}`)
    if (!target || target.includes("\0"))
      throw fail("invalid_options", `Invalid symlink target: ${name}`)
  }
  const base = options.root === undefined ? undefined : await atRoot(source, options.root, signal)
  const fs = reader(source, signal, base)
  const files: Record<string, string> = Object.create(null)
  const symlinks: Record<string, string> = Object.create(null)
  let entries = 0
  let totalBytes = 0
  async function checked<T>(operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const result = await operation()
    signal.throwIfAborted()
    return result
  }
  if ((await checked(() => fs.stat(""))).kind !== "directory") {
    throw fail("refused", "Workspace root must be a directory")
  }
  const prepare = fs.prepare?.bind(fs)
  if (prepare)
    await checked(() => prepare({ maxEntries, maxFileBytes, maxTotalBytes, prune: [...excluded] }))
  const pending = [""]
  while (pending.length) {
    const directory = pending.pop() as string
    const names = await checked(() => fs.list(directory))
    if (entries + names.length > maxEntries)
      throw fail("refused", "Workspace entries limit exceeded")
    const seen = new Set<string>()
    for (const name of names) {
      leaf(name)
      if (seen.has(name)) throw fail("refused", `Workspace duplicate entry name: ${name}`)
      seen.add(name)
    }
    entries += names.length
    for (const name of [...names].sort()) {
      const path = directory ? `${directory}/${name}` : name
      const metadata = await checked(() => fs.stat(path))
      if (!directory && excluded.has(name)) {
        if (metadata.kind !== "directory")
          throw fail("refused", `Excluded root must be a directory: ${name}`)
        continue
      }
      if (!directory && expected.has(name)) {
        if (
          metadata.kind !== "symlink" ||
          metadata.target === undefined ||
          metadata.target !== expected.get(name)
        ) {
          throw fail("refused", `Unexpected root symlink: ${name}`)
        }
        symlinks[name] = metadata.target
        continue
      }
      if (metadata.kind === "directory") {
        pending.push(path)
        continue
      }
      if (metadata.kind !== "file")
        throw fail("refused", `Unsupported workspace entry (${metadata.kind}): ${path}`)
      if (metadata.executable !== false) throw fail("refused", `Executable workspace file: ${path}`)
      const cap = Math.min(maxFileBytes, maxTotalBytes - totalBytes)
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > cap) {
        throw fail("refused", `Workspace file bytes limit exceeded: ${path}`)
      }
      let bytes: Uint8Array
      try {
        bytes = await checked(() => fs.read(path, cap))
      } catch (error) {
        throw grown(error, () => path)
      }
      if (bytes.byteLength > cap)
        throw fail("refused", `Workspace file bytes limit exceeded: ${path}`)
      if (bytes.includes(0)) throw fail("refused", `Binary workspace file: ${path}`)
      try {
        files[path] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch (error) {
        throw fail("refused", `Workspace file is not UTF-8 text: ${path}`, { cause: error })
      }
      totalBytes += bytes.byteLength
    }
  }
  for (const name of expected.keys()) {
    if (!Object.hasOwn(symlinks, name))
      throw fail("refused", `Missing expected root symlink: ${name}`)
  }
  if (options.root !== undefined) await recheckRoot(source, options.root, signal)
  return { files, symlinks, totalBytes, entries }
}
