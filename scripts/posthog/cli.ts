import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createPosthogClient, type PosthogClient } from "./client.js"
import { EVENT_CONTRACT } from "./contract.js"
import { parseEnv } from "./env.js"
import { DEFAULT_COVERAGE, evaluateEvents, fetchRecentEvents } from "./quality.js"
import { applyPlan, computePlan, formatPlan, toSyncClient } from "./sync.js"

export interface CliIo {
  stdout: (line: string) => void
  stderr: (line: string) => void
  env: Record<string, string | undefined>
  client?: PosthogClient
  root?: string
}

const USAGE =
  "Usage: cli.ts plan | apply [--delete-orphans] | quality [--days N] [--limit-per-event N]"

const DAY_MS = 24 * 60 * 60 * 1000

function positiveInt(flag: string, raw: string | undefined): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`)
  return value
}

function parseQualityArgs(args: readonly string[]): { days: number; limitPerEvent: number } {
  let days = 7
  let limitPerEvent = 100
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--days") days = positiveInt("--days", args[++i])
    else if (arg === "--limit-per-event")
      limitPerEvent = positiveInt("--limit-per-event", args[++i])
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return { days, limitPerEvent }
}

const defaultRoot = dirname(fileURLToPath(import.meta.url))

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (command !== "plan" && command !== "apply" && command !== "quality") {
      io.stderr(USAGE)
      return 1
    }
    const root = io.root ?? defaultRoot
    const client = io.client ?? createPosthogClient(parseEnv(io.env))

    if (command === "plan") {
      const plan = await computePlan({ root, client: toSyncClient(client) })
      const empty = plan.create.length + plan.update.length + plan.orphan.length === 0
      io.stdout(empty ? "nothing to do" : formatPlan(plan))
      return 0
    }

    if (command === "apply") {
      const unknown = rest.find((arg) => arg !== "--delete-orphans")
      if (unknown !== undefined) throw new Error(`Unknown argument: ${unknown}`)
      const sync = toSyncClient(client)
      const plan = await computePlan({ root, client: sync })
      const result = await applyPlan({
        root,
        client: sync,
        plan,
        deleteOrphans: rest.includes("--delete-orphans"),
      })
      io.stdout(`applied ${result.applied}, failed ${result.failed}`)
      for (const error of result.errors) {
        io.stderr(`${error.kind} ${error.slug}: ${error.error}`)
      }
      return result.failed > 0 ? 1 : 0
    }

    const { days, limitPerEvent } = parseQualityArgs(rest)
    const after = new Date(Date.now() - days * DAY_MS).toISOString()
    const events = await fetchRecentEvents(client, {
      eventNames: Object.keys(EVENT_CONTRACT).sort(),
      after,
      limitPerEvent,
    })
    const findings = evaluateEvents(events, DEFAULT_COVERAGE)
    for (const finding of findings) {
      io.stdout(`[${finding.severity}] ${finding.kind}: ${finding.message} (${finding.timestamp})`)
    }
    if (findings.length === 0) io.stdout(`no findings across ${events.length} sampled events`)
    return findings.some((finding) => finding.severity === "error") ? 1 : 0
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err))
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    env: process.env,
  }).then((code) => {
    process.exitCode = code
  })
}
