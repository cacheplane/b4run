import type { WalkedEntry } from "@b4run/workspace"
import { boundedReadCommand, decodeBoundedRead, validMaxBytes } from "./bounded-read.js"

type Run = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>

function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Metadata from `stat -c '%f %s'` output, shared by `lstat` and `walkTree`. */
export function metadataFromStat(line: string): Omit<WalkedEntry, "path" | "target"> {
  const match = /^([a-fA-F0-9]+) ([0-9]+)$/.exec(line)
  if (!match) throw new Error("Invalid lstat response")
  const mode = Number.parseInt(match[1] ?? "", 16)
  const size = Number(match[2])
  if (!Number.isSafeInteger(size)) throw new Error("Invalid lstat size")
  const type = mode & 0xf000
  const kind =
    type === 0xa000 ? "symlink" : type === 0x8000 ? "file" : type === 0x4000 ? "directory" : "other"
  return { kind, size, executable: (mode & 0o111) !== 0 }
}

/**
 * Upper bound on the walk's framed output per entry: a stat line, a path and a
 * link target of at most PATH_MAX each, and their separators. The walk is cut
 * off in the sandbox at `(maxEntries + 1)` of these, so a tree of any size
 * costs bounded transport, and a cut-off walk fails as over the entry limit.
 */
const WALK_BYTES_PER_ENTRY = 8448

/**
 * One sandbox command per batch of entries `find` hands over: the entry count,
 * one `%f %s` stat line per entry (no names, so a newline in a name cannot
 * shift the lines), the entries' paths NUL-terminated, then each entry's link
 * target NUL-terminated (empty for a non-link). Names are never parsed out of
 * a line-oriented format.
 */
const WALK_BATCH = [
  'printf "%s\\n" "$#"',
  'stat -c "%f %s" -- "$@" || exit 1',
  'printf "%s\\0" "$@"',
  'for p; do if [ -L "$p" ]; then readlink -n -- "$p" || exit 1; fi; printf "\\0"; done',
].join("; ")

/** Every character escaped, so a pruned name is matched literally by `find -path`. */
function literalPattern(path: string): string {
  return [...path].map((char) => `\\${char}`).join("")
}

/**
 * Walk the tree below `path` in one sandbox command. Mirrors `lstat`: symlinks
 * are reported, not followed. The whole framed output is base64-encoded in the
 * sandbox, so names reach the host as exact bytes whatever the transport's text
 * decoding does to a multi-byte character split across chunks.
 */
export async function walkSandboxTree(
  path: string,
  opts: { readonly maxEntries: number; readonly prune?: readonly string[] },
  run: Run,
): Promise<readonly WalkedEntry[]> {
  if (!Number.isSafeInteger(opts.maxEntries) || opts.maxEntries < 0)
    throw new Error("Invalid walk entries limit")
  const base = path.length > 1 ? path.replace(/\/+$/, "") : path
  if (!base.startsWith("/")) throw new Error("walkTree requires an absolute path")
  const prefix = base === "/" ? "/" : `${base}/`
  const prune = opts.prune ?? []
  for (const name of prune)
    if (!name || name.includes("/") || name.includes("\0"))
      throw new Error(`Invalid walk prune name: ${JSON.stringify(name)}`)
  const pruned = prune.length
    ? `\\( \\( ${prune.map((name) => `-path ${q(literalPattern(prefix + name))}`).join(" -o ")} \\) -prune -o -true \\) `
    : ""
  const cap = (opts.maxEntries + 1) * WALK_BYTES_PER_ENTRY
  const result = await run(
    `{ find ${q(base)} -mindepth 1 ${pruned}-exec sh -c ${q(WALK_BATCH)} b4-walk {} +; ` +
      `printf 'B4_WALK_STATUS_%s\\n' "$?"; } | head -c ${cap + 1} | base64`,
  )
  if (result.exitCode !== 0) throw new Error(`walkTree failed: ${result.stderr.trim()}`)
  const bytes = Buffer.from(result.stdout.replace(/\s/g, ""), "base64")
  if (bytes.length > cap) throw new Error("Workspace entries limit exceeded")

  const entries: WalkedEntry[] = []
  let at = 0
  const until = (terminator: number): Buffer => {
    const end = bytes.indexOf(terminator, at)
    if (end < 0) throw new Error("Invalid walkTree response")
    const field = bytes.subarray(at, end)
    at = end + 1
    return field
  }
  const footer = Buffer.from("B4_WALK_STATUS_")
  for (;;) {
    if (bytes.subarray(at, at + footer.length).equals(footer)) {
      const status = /^B4_WALK_STATUS_(\d+)\n$/.exec(bytes.subarray(at).toString("ascii"))
      if (!status) throw new Error("Invalid walkTree response")
      if (status[1] !== "0")
        throw new Error(`walkTree failed: ${result.stderr.trim() || `status ${status[1]}`}`)
      return entries
    }
    const count = Number(until(0x0a).toString("ascii"))
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid walkTree response")
    const stats = Array.from({ length: count }, () =>
      metadataFromStat(until(0x0a).toString("ascii")),
    )
    const paths = Array.from({ length: count }, () => until(0).toString("utf8"))
    const targets = Array.from({ length: count }, () => until(0).toString("utf8"))
    for (let index = 0; index < count; index++) {
      const full = paths[index] as string
      if (!full.startsWith(prefix) || full.length === prefix.length)
        throw new Error("Invalid walkTree response")
      const metadata = stats[index] as Omit<WalkedEntry, "path">
      entries.push({
        path: full.slice(prefix.length),
        ...metadata,
        ...(metadata.kind === "symlink" ? { target: targets[index] as string } : {}),
      })
      if (entries.length > opts.maxEntries) throw new Error("Workspace entries limit exceeded")
    }
  }
}

/**
 * Longest sandbox script one read batch builds. Linux caps a single argv
 * string (the `sh -c` script) at 128 KiB, so requests are split well below it.
 */
const READ_SCRIPT_BYTES = 96 * 1024

/**
 * `readBinaryFile` for many paths, one sandbox command per batch. Each file is
 * the same bounded, status-framed read `readBinaryFile` performs, base64-encoded
 * and followed by a `#` line, a byte base64 never emits. `run` receives a whole
 * POSIX sh script, and may pass it as `sh -c` argv or on `sh -s` stdin.
 */
export async function readSandboxFiles(
  requests: readonly { readonly path: string; readonly maxBytes: number }[],
  run: Run,
): Promise<readonly Uint8Array[]> {
  for (const request of requests) validMaxBytes(request.maxBytes)
  const results: Uint8Array[] = []
  let at = 0
  while (at < requests.length) {
    const batch: (typeof requests)[number][] = []
    let script = ""
    let scriptBytes = 0
    while (at < requests.length) {
      const request = requests[at] as (typeof requests)[number]
      // `</dev/null`: when a backend feeds this script to `sh` on stdin, no command in it
      // may consume the rest of the script. The read's own `< path` still wins inside.
      const line = `${boundedReadCommand(request.path, request.maxBytes)} </dev/null | base64; printf '#\\n'\n`
      // Bytes, not UTF-16 units: the kernel's argv cap counts bytes, and a non-ASCII
      // name costs up to three bytes per character.
      const lineBytes = Buffer.byteLength(line)
      if (batch.length && scriptBytes + lineBytes > READ_SCRIPT_BYTES) break
      script += line
      scriptBytes += lineBytes
      batch.push(request)
      at++
    }
    const result = await run(script)
    if (result.exitCode !== 0) throw new Error(`readBinaryFile failed: ${result.stderr.trim()}`)
    const blobs = result.stdout.split(/^#$/m)
    const trailing = blobs.pop()
    if (blobs.length !== batch.length || trailing?.trim())
      throw new Error("Invalid readBinaryFiles response")
    batch.forEach((request, index) => {
      const framed = Buffer.from((blobs[index] as string).replace(/\s/g, ""), "base64")
      results.push(
        decodeBoundedRead(framed, request.path, request.maxBytes, "readBinaryFile", result.stderr),
      )
    })
  }
  return results
}
