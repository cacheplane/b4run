import type { WorkspaceFs } from "@b4run/sdk"
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

/**
 * Serve `list` and `stat` from one `walkTree` and the file reads from one
 * `readBinaryFiles`, so an inspection costs a few backend calls instead of one
 * per entry. The walk is only a cache for the policy loop in
 * {@link inspectWorkspace}, which applies exactly the checks it applies to
 * per-entry calls. Every walked name is validated here, and an entry whose
 * parent is not a walked directory is refused.
 *
 * Files are prefetched with `maxBytes` set to their walked size, so a file that
 * grew between the walk and the read is refused rather than read past its
 * recorded size. Prefetch is skipped when the eligible files together exceed
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
      if (tree && path) throw new Error(`Workspace changed during inspection: ${path}`)
      return single.stat(path)
    },
    list: (path) => {
      if (!tree) return single.list(path)
      const names = children.get(path)
      if (!names) throw new Error(`Workspace changed during inspection: ${path}`)
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
      if (walked.length > plan.maxEntries) throw new Error("Workspace entries limit exceeded")
      const found = new Map<string, Metadata>()
      children.set("", [])
      for (const entry of walked) {
        const segments = entry.path.split("/")
        for (const segment of segments) leaf(segment)
        if (found.has(entry.path)) throw new Error(`Workspace duplicate entry name: ${entry.path}`)
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
          throw new Error(`Invalid workspace entry name: ${JSON.stringify(entry.path)}`)
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
        const read = await fs.readBinaryFiles(
          files.map((entry) => ({ path: absolute(entry.path), maxBytes: entry.size })),
          ctx,
        )
        if (read.length !== files.length) throw new Error("Invalid batch read response")
        files.forEach((entry, index) => {
          bytes.set(entry.path, read[index] as Uint8Array)
        })
      }
      tree = found
    },
  }
}

function reader(source: WorkspaceFs | WorkspaceReadSource, signal: AbortSignal): Reader {
  if ("filesystem" in source) {
    const fs = source.filesystem
    const stat = fs.lstat?.bind(fs)
    const read = fs.readBinaryFile?.bind(fs)
    if (!stat) throw new Error("Workspace inspection requires leaf metadata (lstat)")
    if (!read) throw new Error("Workspace inspection requires binary reads")
    const root = source.workspaceRoot.replace(/\/$/, "")
    if (
      !source.workspaceRoot.startsWith("/") ||
      /[\\\0]/.test(root) ||
      root.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error("Workspace inspection requires an absolute canonical workspace root")
    }
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
  if (!stat) throw new Error("Workspace inspection requires leaf metadata (stat)")
  if (!source.readBinaryFile) throw new Error("Workspace inspection requires binary reads")
  return {
    stat: (path) => stat(path || "."),
    list: (path) => source.listDir(path || "."),
    read: (path, maxBytes) => source.readBinaryFile(path, { maxBytes }),
  }
}

function leaf(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error(`Invalid workspace entry name: ${JSON.stringify(name)}`)
  }
}

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name} limit`)
  return value
}

/**
 * Inspect text without shell execution, preserving BOM bytes and rejecting unsupported
 * entries. Metadata and raw reads are mandatory. This is not an atomic snapshot:
 * callers must quiesce writers or revalidate before acting on the inventory.
 */
export async function inspectWorkspace(
  source: WorkspaceFs | WorkspaceReadSource,
  options: InspectWorkspaceOptions = {},
): Promise<WorkspaceInspection> {
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const fs = reader(source, signal)
  const maxEntries = limit(options.maxEntries ?? 10_000, "entries")
  const maxFileBytes = limit(options.maxFileBytes ?? 2 * 1024 * 1024, "file bytes")
  const maxTotalBytes = limit(options.maxTotalBytes ?? 16 * 1024 * 1024, "total bytes")
  const excluded = new Set(options.excludeRootDirectories ?? [])
  const expected = new Map(Object.entries(options.expectedRootSymlinks ?? {}))
  for (const name of [...excluded, ...expected.keys()]) leaf(name)
  for (const [name, target] of expected) {
    if (excluded.has(name)) throw new Error(`Conflicting root policy: ${name}`)
    if (!target || target.includes("\0")) throw new Error(`Invalid symlink target: ${name}`)
  }
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
    throw new Error("Workspace root must be a directory")
  }
  const prepare = fs.prepare?.bind(fs)
  if (prepare)
    await checked(() => prepare({ maxEntries, maxFileBytes, maxTotalBytes, prune: [...excluded] }))
  const pending = [""]
  while (pending.length) {
    const directory = pending.pop() as string
    const names = await checked(() => fs.list(directory))
    if (entries + names.length > maxEntries) throw new Error("Workspace entries limit exceeded")
    const seen = new Set<string>()
    for (const name of names) {
      leaf(name)
      if (seen.has(name)) throw new Error(`Workspace duplicate entry name: ${name}`)
      seen.add(name)
    }
    entries += names.length
    for (const name of [...names].sort()) {
      const path = directory ? `${directory}/${name}` : name
      const metadata = await checked(() => fs.stat(path))
      if (!directory && excluded.has(name)) {
        if (metadata.kind !== "directory")
          throw new Error(`Excluded root must be a directory: ${name}`)
        continue
      }
      if (!directory && expected.has(name)) {
        if (
          metadata.kind !== "symlink" ||
          metadata.target === undefined ||
          metadata.target !== expected.get(name)
        ) {
          throw new Error(`Unexpected root symlink: ${name}`)
        }
        symlinks[name] = metadata.target
        continue
      }
      if (metadata.kind === "directory") {
        pending.push(path)
        continue
      }
      if (metadata.kind !== "file")
        throw new Error(`Unsupported workspace entry (${metadata.kind}): ${path}`)
      if (metadata.executable !== false) throw new Error(`Executable workspace file: ${path}`)
      const cap = Math.min(maxFileBytes, maxTotalBytes - totalBytes)
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > cap) {
        throw new Error(`Workspace file bytes limit exceeded: ${path}`)
      }
      const bytes = await checked(() => fs.read(path, cap))
      if (bytes.byteLength > cap) throw new Error(`Workspace file bytes limit exceeded: ${path}`)
      if (bytes.includes(0)) throw new Error(`Binary workspace file: ${path}`)
      files[path] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
      totalBytes += bytes.byteLength
    }
  }
  for (const name of expected.keys()) {
    if (!Object.hasOwn(symlinks, name)) throw new Error(`Missing expected root symlink: ${name}`)
  }
  return { files, symlinks, totalBytes, entries }
}
