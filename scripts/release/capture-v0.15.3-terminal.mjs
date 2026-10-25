#!/usr/bin/env node
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { createGitHubReader } from "./adapters/github.mjs"
import { createNpmReader } from "./adapters/npm.mjs"
import { captureTagged0153Record } from "./tagged-0153-recovery.mjs"
import { parseOperatorRecoveryRecord, TAGGED_0153_RECOVERY } from "./terminal-record-store.mjs"

/**
 * Capture incident-specific evidence from an exact clean reviewed checkout.
 * The output is exclusive and private; this command has no mutation transport
 * for GitHub, Git, or npm. Merging its bytes requires a separate reviewed PR.
 */
export async function runTagged0153Capture(
  argv,
  {
    cwd = process.cwd(),
    environment = process.env,
    readCheckout = checkout,
    createReaders = readers,
    capture = captureTagged0153Record,
  } = {},
) {
  if (!Array.isArray(argv) || argv.length !== 4)
    throw new Error("Expected --reviewed-commit SHA --output PATH")
  const args = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !["--reviewed-commit", "--output"].includes(argv[i]) ||
      args.has(argv[i]) ||
      typeof argv[i + 1] !== "string" ||
      argv[i + 1].length === 0
    )
      throw new Error("Arguments must be exact")
    args.set(argv[i], argv[i + 1])
  }
  const reviewedCommit = args.get("--reviewed-commit")
  if (
    typeof reviewedCommit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(reviewedCommit) ||
    !args.has("--output")
  )
    throw new Error("Invalid reviewed commit or output")
  const output = resolve(cwd, args.get("--output"))
  try {
    await lstat(output)
    throw new Error("Output already exists")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const state = await readCheckout(cwd)
  if (state.head !== reviewedCommit || state.status !== "")
    throw new Error("Recovery requires an exact clean reviewed checkout")
  const services = createReaders(environment)
  const bytes = await capture({ ...services, reviewedCommit })
  const record = parseOperatorRecoveryRecord(bytes)
  if (record.schemaVersion !== 2 || record.authority.reviewedCommit !== reviewedCommit)
    throw new Error("Captured record does not bind this reviewed checkout")
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 })
  return { output, sha256: createHash("sha256").update(bytes).digest("hex") }
}

async function checkout(cwd) {
  const run = promisify(execFile)
  const options = { cwd, timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" }
  const [head, status] = await Promise.all([
    run("git", ["rev-parse", "--verify", "HEAD"], options),
    run("git", ["status", "--porcelain", "--untracked-files=normal"], options),
  ])
  return { head: head.stdout.trim(), status: status.stdout }
}

function readers(environment) {
  const token = environment.GITHUB_TOKEN
  if (typeof token !== "string" || token.length === 0 || /[\r\n]/u.test(token))
    throw new Error("GITHUB_TOKEN is required")
  return {
    github: createGitHubReader({
      owner: "cacheplane",
      repo: "b4run",
      repositoryId: String(TAGGED_0153_RECOVERY.repositoryId),
      token,
      paginationTimeoutMs: 60000,
    }),
    npm: createNpmReader(),
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runTagged0153Capture(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    () => {
      console.error(
        "0.15.3 recovery capture failed; no release state was changed. Preserve any partial output and inspect the capture conditions before retrying.",
      )
      process.exitCode = 1
    },
  )
}
