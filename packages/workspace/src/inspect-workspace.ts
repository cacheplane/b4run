import type { WorkspaceFs } from "@b4run/sdk"
import type { SandboxHandle } from "./sandbox-types.js"

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
interface Reader {
  stat(path: string): Promise<Metadata>
  list(path: string): Promise<readonly string[]>
  read(path: string, maxBytes: number): Promise<Uint8Array>
}

function reader(source: WorkspaceFs | SandboxHandle, signal: AbortSignal): Reader {
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
    return {
      stat: (path) => stat(absolute(path), ctx),
      list: (path) => fs.listDir(absolute(path), ctx),
      read: (path, maxBytes) => read(absolute(path), ctx, { maxBytes }),
    }
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
  source: WorkspaceFs | SandboxHandle,
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
