import { type BigIntStats, constants } from "node:fs"
import { lstat, open, opendir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { createSourceBundle, type SourceBundle, type SourceFileInput } from "./source-bundle.js"
import {
  addSize,
  checkPaths,
  entries,
  MAX_ENTRIES,
  portablePath,
  record,
} from "./source-validation.js"

export interface WorkspaceSourceDefinition {
  readonly directory: string
  readonly include: readonly string[]
  readonly excludeDirectories?: readonly string[]
  readonly files?: readonly (
    | { readonly path: string; readonly file: string }
    | { readonly path: string; readonly text: string; readonly executable?: boolean }
  )[]
}

function shape(value: unknown, required: string[], optional: string[]) {
  if (value === null || typeof value !== "object") throw new Error("Expected source descriptor")
  const keys = Reflect.ownKeys(value)
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key))
  )
    throw new Error("Unexpected source descriptor fields")
  return record(value, keys as string[])
}

function validate(input: WorkspaceSourceDefinition) {
  const value = shape(input, ["directory", "include"], ["excludeDirectories", "files"])
  const directory = value.directory === "." ? "." : portablePath(value.directory)
  const include = entries(value.include).map(portablePath)
  const exclusions =
    "excludeDirectories" in value ? entries(value.excludeDirectories).map(portablePath) : []
  let total = 0
  const files = ("files" in value ? entries(value.files) : []).map((item) => {
    const file = shape(item, ["path"], ["file", "text", "executable"])
    const path = portablePath(file.path)
    if ("file" in file === "text" in file)
      throw new Error("Expected exactly one file or text variant")
    if ("file" in file) {
      if ("executable" in file)
        throw new Error("Referenced source executable comes from filesystem")
      return { path, file: portablePath(file.file) }
    }
    if (
      typeof file.text !== "string" ||
      ("executable" in file && typeof file.executable !== "boolean")
    )
      throw new Error("Invalid inline source text or executable")
    total = addSize(total, Buffer.byteLength(file.text))
    const bytes = Buffer.from(file.text)
    if (bytes.toString("utf8") !== file.text)
      throw new Error("Inline source text must roundtrip UTF-8")
    return { path, bytes, executable: file.executable === true }
  })
  if (include.length + files.length > MAX_ENTRIES)
    throw new Error("Source entries count exceeds 10000")
  checkPaths([...include.map((path) => ({ path })), ...files])
  // Directory declarations participate in casing checks, including the final segment.
  checkPaths(exclusions.map((path) => ({ path })))
  const spelling = new Map<string, string>()
  const directoryPaths = [
    ...include,
    ...exclusions.map((path) => `${path}/_`),
    ...files.map((file) => file.path),
  ]
  const referencePaths = [
    directory === "." ? "_" : `${directory}/_`,
    ...files.flatMap((file) => (file.file ? [file.file] : [])),
    ...include.map((path) => (directory === "." ? path : `${directory}/${path}`)),
    ...exclusions.map((path) => `${directory === "." ? "" : `${directory}/`}${path}/_`),
  ]
  for (const group of [directoryPaths, referencePaths]) {
    spelling.clear()
    for (const path of group) {
      const segments = path.split("/")
      for (let i = 1; i < segments.length; i++) {
        const prefix = segments.slice(0, i).join("/")
        const previous = spelling.get(prefix.toLowerCase())
        if (previous !== undefined && previous !== prefix)
          throw new Error("Source directory casing collision")
        spelling.set(prefix.toLowerCase(), prefix)
      }
    }
  }
  for (const excluded of exclusions)
    for (const path of include) {
      const a = excluded.toLowerCase()
      const b = path.toLowerCase()
      if (a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`))
        throw new Error("Source exclusion overlaps include")
    }
  return { directory, include, exclusions, files, total }
}

function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}

/** Capture a trusted application tree; metadata checks detect changes, not an atomic snapshot. */
export async function captureWorkspaceSource(
  appRoot: string,
  definition: WorkspaceSourceDefinition,
  options: { readonly signal?: AbortSignal } = {},
): Promise<SourceBundle> {
  const input = validate(definition)
  const checkAbort = () => options.signal?.throwIfAborted()
  checkAbort()
  const root = await realpath(appRoot)
  const tracked = new Map<string, BigIntStats>()
  // One capture-wide budget includes appRoot, ancestors, exclusions and extra references.
  const visited = new Set<string>()
  async function inspect(path: string) {
    checkAbort()
    if (!visited.has(path)) {
      if (visited.size >= MAX_ENTRIES) throw new Error("Source traversal entry limit exceeded")
      visited.add(path)
    }
    const stats = await lstat(path, { bigint: true })
    if (stats.isSymbolicLink()) throw new Error(`Source symlink rejected: ${path}`)
    const previous = tracked.get(path)
    if (previous && !same(previous, stats))
      throw new Error(`Source changed during capture: ${path}`)
    tracked.set(path, stats)
    return stats
  }
  async function resolve(reference: string, isDirectory: boolean) {
    let path = root
    const rootStats = await inspect(path)
    if (!rootStats.isDirectory()) throw new Error("Source root must be directory")
    if (reference !== ".") {
      const segments = reference.split("/")
      for (let i = 0; i < segments.length; i++) {
        path = join(path, segments[i] as string)
        const stats = await inspect(path)
        if ((isDirectory || i < segments.length - 1) && !stats.isDirectory())
          throw new Error("Source ancestor must be directory")
      }
    }
    return path
  }
  const source = await resolve(input.directory, true)
  for (const exclusion of input.exclusions)
    await resolve(input.directory === "." ? exclusion : `${input.directory}/${exclusion}`, true)
  async function inventory() {
    let count = 0
    const found: string[] = []
    const stack = [{ absolute: source, relative: "" }]
    while (stack.length) {
      checkAbort()
      const directory = stack.pop()
      if (!directory) break
      await inspect(directory.absolute)
      const handle = await opendir(directory.absolute)
      try {
        while (true) {
          checkAbort()
          const entry = await handle.read()
          if (!entry) break
          if (++count > MAX_ENTRIES) throw new Error("Source traversal entry limit exceeded")
          const relative = portablePath(
            directory.relative ? `${directory.relative}/${entry.name}` : entry.name,
          )
          const absolute = join(directory.absolute, entry.name)
          const stats = await inspect(absolute)
          if (input.exclusions.includes(relative)) {
            if (!stats.isDirectory()) throw new Error("Source exclusion must be directory")
          } else if (stats.isDirectory()) stack.push({ absolute, relative })
          else if (stats.isFile()) found.push(relative)
          else throw new Error("Source must contain regular files only")
        }
      } finally {
        await handle.close()
      }
    }
    found.sort()
    const expected = [...input.include].sort()
    if (found.length !== expected.length || found.some((path, i) => path !== expected[i]))
      throw new Error("Source exact inventory mismatch")
    return found
  }
  await inventory()
  let total = input.total
  const result: SourceFileInput[] = []
  async function read(path: string, reference: string) {
    const absolute = await resolve(reference, false)
    const expected = await inspect(absolute)
    if (!expected.isFile()) throw new Error("Source must be a regular file")
    if (expected.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Source file byte limit exceeded")
    const size = Number(expected.size)
    total = addSize(total, size)
    checkAbort()
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || !same(expected, before))
        throw new Error("Source changed before reading regular file")
      const bytes = Buffer.alloc(size)
      let offset = 0
      while (offset < size) {
        checkAbort()
        const read = await handle.read(bytes, offset, Math.min(size - offset, 64 * 1024), offset)
        if (read.bytesRead === 0) throw new Error("Source changed during read")
        offset += read.bytesRead
      }
      checkAbort()
      const probe = await handle.read(Buffer.alloc(1), 0, 1, size)
      const after = await handle.stat({ bigint: true })
      if (probe.bytesRead !== 0 || !same(before, after))
        throw new Error("Source changed during read")
      await inspect(absolute)
      result.push({ path, bytes, executable: (before.mode & 0o111n) !== 0n })
    } finally {
      await handle.close()
    }
  }
  for (const path of input.include)
    await read(path, input.directory === "." ? path : `${input.directory}/${path}`)
  for (const file of input.files) {
    if (file.file !== undefined) await read(file.path, file.file)
    else
      result.push({
        path: file.path,
        bytes: file.bytes as Uint8Array,
        executable: file.executable === true,
      })
  }
  await inventory()
  for (const path of tracked.keys()) await inspect(path)
  checkAbort()
  return createSourceBundle(result)
}
