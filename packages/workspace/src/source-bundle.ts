import { createHash } from "node:crypto"

export interface SourceFileInput {
  readonly path: string
  readonly bytes: Uint8Array
  readonly executable: boolean
}

export interface SourceBundle {
  readonly version: 1
  readonly digest: string
  readonly files: readonly {
    readonly path: string
    readonly base64: string
    readonly executable: boolean
  }[]
}

type Entry = SourceBundle["files"][number]
const MAX_ENTRIES = 10_000
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Expected a plain source record")
  }
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error("Unexpected source record fields")
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("Expected own source data fields")
  }
  return value as Record<string, unknown>
}

function entries(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Source entries must be an array")
  if (value.length > MAX_ENTRIES) throw new Error("Source entries count exceeds 10000")
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new Error("Source array must contain only indexed entries")
  }
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("Source array must contain own data entries")
    }
  }
  return value
}

function portablePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024)
    throw new Error("Source path length must be 1 to 1024 ASCII bytes")
  if (!/^[A-Za-z0-9._ /-]+$/.test(value))
    throw new Error("Source path must use portable ASCII characters")
  for (const segment of value.split("/")) {
    if (
      segment.length === 0 ||
      segment.length > 255 ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(" ") ||
      /[ .]$/.test(segment) ||
      segment.includes("  ") ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment)
    ) {
      throw new Error("Invalid portable source path segment")
    }
  }
  return value
}

function mode(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Source executable must be boolean")
  return value
}

function checkPaths(files: readonly { readonly path: string }[]): void {
  const paths = new Set<string>()
  const directories = new Map<string, string>()
  for (const file of files) {
    const path = file.path.toLowerCase()
    if (paths.has(path)) throw new Error("Duplicate or case-insensitive source path collision")
    paths.add(path)
    let slash = file.path.indexOf("/")
    while (slash !== -1) {
      const directory = file.path.slice(0, slash)
      const folded = directory.toLowerCase()
      const previous = directories.get(folded)
      if (previous !== undefined && previous !== directory) {
        throw new Error("Source directory casing collision")
      }
      directories.set(folded, directory)
      slash = file.path.indexOf("/", slash + 1)
    }
  }
  for (const path of paths) {
    let slash = path.indexOf("/")
    while (slash !== -1) {
      if (paths.has(path.slice(0, slash))) throw new Error("Source file/ancestor path conflict")
      slash = path.indexOf("/", slash + 1)
    }
  }
}

function addSize(total: number, size: number): number {
  if (size > MAX_FILE_BYTES) throw new Error("Source file byte limit exceeded")
  if (total + size > MAX_TOTAL_BYTES) throw new Error("Source total byte limit exceeded")
  return total + size
}

// Validate padding bits as well as alphabet, without allocating decoded buffers.
function base64Size(value: unknown): number {
  if (typeof value !== "string") throw new Error("Source base64 must be a string")
  if (value.length > 4 * Math.ceil(MAX_FILE_BYTES / 3))
    throw new Error("Source file byte limit exceeded")
  if (value.length % 4 !== 0) throw new Error("Noncanonical source base64 length")
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const size = (value.length / 4) * 3 - padding
  if (size > MAX_FILE_BYTES) throw new Error("Source file byte limit exceeded")
  for (let i = 0; i < value.length - padding; i++) {
    if (BASE64.indexOf(value.charAt(i)) === -1) throw new Error("Invalid source base64 alphabet")
  }
  if (
    padding &&
    (BASE64.indexOf(value.charAt(value.length - padding - 1)) & (padding === 2 ? 15 : 3)) !== 0
  ) {
    throw new Error("Noncanonical source base64 padding bits")
  }
  return size
}

function digest(files: readonly Entry[]): string {
  const hash = createHash("sha256").update('["b4-workspace-source-v1",[')
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!file) throw new Error("Missing source entry")
    if (i > 0) hash.update(",")
    hash.update(JSON.stringify([file.path, file.base64, file.executable]))
  }
  return hash.update("]]").digest("hex")
}

function freeze(files: Entry[], identity = digest(files)): SourceBundle {
  return Object.freeze({
    version: 1,
    digest: identity,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  })
}

export function createSourceBundle(files: readonly SourceFileInput[]): SourceBundle {
  let total = 0
  const inputs = entries(files).map((value) => {
    const file = record(value, ["path", "bytes", "executable"])
    const path = portablePath(file.path)
    const executable = mode(file.executable)
    if (!(file.bytes instanceof Uint8Array)) throw new Error("Source bytes must be Uint8Array")
    total = addSize(total, file.bytes.byteLength)
    return { path, executable, bytes: file.bytes }
  })
  checkPaths(inputs)
  inputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  // All lengths and conflicts are checked before copying any content.
  return freeze(
    inputs.map(({ path, bytes, executable }) => ({
      path,
      base64: Buffer.from(bytes).toString("base64"),
      executable,
    })),
  )
}

export function verifySourceBundle(value: unknown): SourceBundle {
  const bundle = record(value, ["version", "digest", "files"])
  if (bundle.version !== 1) throw new Error("Unsupported source bundle version")
  if (typeof bundle.digest !== "string" || !/^[0-9a-f]{64}$/.test(bundle.digest))
    throw new Error("Invalid source bundle digest")
  let total = 0
  let previous: string | undefined
  const files = entries(bundle.files).map((value) => {
    const file = record(value, ["path", "base64", "executable"])
    const path = portablePath(file.path)
    const executable = mode(file.executable)
    if (previous !== undefined && previous >= path)
      throw new Error("Source entries must be in strictly increasing path order")
    previous = path
    total = addSize(total, base64Size(file.base64))
    return { path, base64: file.base64 as string, executable }
  })
  checkPaths(files)
  const identity = digest(files)
  if (identity !== bundle.digest) throw new Error("Source bundle digest mismatch")
  return freeze(files, identity)
}

export function readSourceFile(bundle: SourceBundle, path: string): Uint8Array {
  const validPath = portablePath(path)
  const file = verifySourceBundle(bundle).files.find((entry) => entry.path === validPath)
  if (!file) throw new Error(`Missing source file: ${validPath}`)
  const bytes = Buffer.from(file.base64, "base64")
  return new Uint8Array(bytes)
}
