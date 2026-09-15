export const MAX_ENTRIES = 10_000
export const MAX_FILE_BYTES = 16 * 1024 * 1024
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
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

export function entries(value: unknown): unknown[] {
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

export function portablePath(value: unknown): string {
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

export function mode(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Source executable must be boolean")
  return value
}

export function checkPaths(files: readonly { readonly path: string }[]): void {
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

export function addSize(total: number, size: number): number {
  if (size > MAX_FILE_BYTES) throw new Error("Source file byte limit exceeded")
  if (total + size > MAX_TOTAL_BYTES) throw new Error("Source total byte limit exceeded")
  return total + size
}
