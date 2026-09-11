import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { TextDecoder } from "node:util"

export const METADATA_ONLY_PATHS = Object.freeze(["apps/web/app/seo/lastmod.generated.json"])

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const METADATA_ONLY_PATH_SET = new Set(METADATA_ONLY_PATHS)

function expectCommitSha(value, name) {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`Pull-request ${name} SHA must be exactly 40 lowercase hexadecimal characters`)
  }
  return value
}

function parseNulDelimitedPaths(output) {
  if (output.length === 0) return []
  if (output[output.length - 1] !== 0) {
    throw new Error("Malformed NUL-delimited Git diff output: missing final NUL byte")
  }

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const paths = []
  let start = 0
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue
    if (index === start) {
      throw new Error("Malformed NUL-delimited Git diff output: empty filename")
    }
    try {
      paths.push(decoder.decode(output.subarray(start, index)))
    } catch (cause) {
      throw new Error("Malformed Git diff filename: expected valid UTF-8", { cause })
    }
    start = index + 1
  }
  return paths
}

async function runGitCommand(file, args) {
  return {
    stdout: execFileSync(file, args, {
      encoding: "buffer",
      maxBuffer: 32 * 1_024 * 1_024,
      timeout: 30_000,
    }),
  }
}

export async function classifyMetadataOnlyScope(request, runCommand = runGitCommand) {
  if (request.event === "push") return false
  if (request.event !== "pull_request") {
    throw new Error(`Unknown CI scope event mode: ${String(request.event)}`)
  }

  const base = expectCommitSha(request.base, "base")
  const head = expectCommitSha(request.head, "head")
  await runCommand("git", ["cat-file", "-e", `${base}^{commit}`])
  await runCommand("git", ["cat-file", "-e", `${head}^{commit}`])
  const { stdout } = await runCommand("git", [
    "diff",
    "--merge-base",
    "--no-renames",
    "--name-only",
    "-z",
    base,
    head,
  ])
  if (!Buffer.isBuffer(stdout)) {
    throw new Error("Malformed Git diff output: expected a Buffer")
  }

  const paths = parseNulDelimitedPaths(stdout)
  return paths.length > 0 && paths.every((path) => METADATA_ONLY_PATH_SET.has(path))
}

// Runbooks are not compiled, bundled, or evaluated by the application. Keep this
// narrower than all Markdown: package READMEs, site MDX, and configuration still
// need their normal validation lanes.
const PROSE_PATH =
  /^docs\/superpowers\/runbooks\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/u

export async function classifyProseOnlyScope(request, runCommand = runGitCommand) {
  if (request.event === "push") return false
  if (request.event !== "pull_request") {
    throw new Error(`Unknown CI scope event mode: ${String(request.event)}`)
  }
  const base = expectCommitSha(request.base, "base")
  const head = expectCommitSha(request.head, "head")
  await runCommand("git", ["cat-file", "-e", `${base}^{commit}`])
  await runCommand("git", ["cat-file", "-e", `${head}^{commit}`])
  const { stdout } = await runCommand("git", [
    "diff",
    "--merge-base",
    "--no-renames",
    "--raw",
    "--abbrev=40",
    "-z",
    base,
    head,
  ])
  if (!Buffer.isBuffer(stdout)) throw new Error("Malformed Git diff output: expected a Buffer")
  const tokens = parseNulDelimitedPaths(stdout)
  if (tokens.length % 2 !== 0) throw new Error("Malformed raw Git diff records")
  if (tokens.length === 0) return false
  let proseOnly = true
  for (let index = 0; index < tokens.length; index += 2) {
    const header = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT])$/u.exec(tokens[index])
    if (header === null) throw new Error("Malformed raw Git diff header")
    const [, oldMode, newMode, oldId, newId, status] = header
    const oldAbsent = oldMode === "000000" && oldId === "0".repeat(40)
    const newAbsent = newMode === "000000" && newId === "0".repeat(40)
    const regularOld = oldMode === "100644" && oldId !== "0".repeat(40)
    const regularNew = newMode === "100644" && newId !== "0".repeat(40)
    const regular =
      status === "A"
        ? oldAbsent && regularNew
        : status === "D"
          ? regularOld && newAbsent
          : status === "M" && regularOld && regularNew
    proseOnly &&= regular && PROSE_PATH.test(tokens[index + 1])
  }
  if (!proseOnly) return false
  // Run before emitting true: a failed prose check cannot grant skipped lanes.
  await runCommand("git", ["diff", "--check", "--merge-base", "--no-renames", base, head])
  return true
}

function parseCliArgs(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === undefined || !["--event", "--base", "--head", "--kind"].includes(flag)) {
      throw new Error(`Unknown flag: ${String(flag)}`)
    }
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`Missing value for flag: ${flag}`)
    }
    if (flags.has(flag)) throw new Error(`Duplicate flag: ${flag}`)
    flags.set(flag, value)
  }

  const event = flags.get("--event")
  if (event === undefined) throw new Error("Missing required flag: --event")
  if (event === "push" && (flags.has("--base") || flags.has("--head"))) {
    throw new Error("push scope does not accept pull-request SHA flags")
  }
  const kind = flags.get("--kind") ?? "metadata"
  if (!["metadata", "prose"].includes(kind)) throw new Error("Unknown CI scope kind")
  return {
    kind,
    event,
    ...(flags.has("--base") ? { base: flags.get("--base") } : {}),
    ...(flags.has("--head") ? { head: flags.get("--head") } : {}),
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  Promise.resolve()
    .then(() => {
      const request = parseCliArgs(process.argv.slice(2))
      return request.kind === "prose"
        ? classifyProseOnlyScope(request)
        : classifyMetadataOnlyScope(request)
    })
    .then((metadataOnly) => process.stdout.write(`${String(metadataOnly)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      )
      process.exitCode = 1
    })
}
