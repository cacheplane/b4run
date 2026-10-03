import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMemoryInterruptGrantStore, type InterruptGrantRecord } from "@b4run/sdk"
import { createInterruptGrantStore } from "@b4run/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"
import { runApprovalsCommand } from "../src/commands/approvals.ts"
import { CliError } from "../src/lib/output.ts"

const tempDirs: string[] = []
/** The config string reaches an in-process store through this global, as client-tools-command.test.ts does. */
const STORE_KEY = "__b4ApprovalsCommandTestStore"
afterEach(async () => {
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function makeApp(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b4-approvals-cmd-"))
  tempDirs.push(root)
  await writeFile(
    join(root, "package.json"),
    '{ "name": "approvals-temp-app", "type": "module" }\n',
  )
  if (config !== undefined) await writeFile(join(root, "b4.config.ts"), config)
  return root
}

// `writeLine` hands the io a line with its trailing newline; capture the bare line.
function io() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      stdout: (m: string) => out.push(m.replace(/\n$/, "")),
      stderr: (m: string) => err.push(m.replace(/\n$/, "")),
    },
  }
}

const row = (over: Partial<InterruptGrantRecord>): InterruptGrantRecord => ({
  threadId: "t",
  interruptId: "i",
  checkpointNs: "",
  tokenHash: "0".repeat(64),
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  consumedAt: null,
  consumedDecision: null,
  voidedAt: null,
  ...over,
})

async function seededStore(appRoot: string) {
  const path = join(appRoot, ".b4/interrupt-grants.sqlite")
  await mkdir(join(appRoot, ".b4"), { recursive: true })
  const store = createInterruptGrantStore({ path })
  // Voided 30 days ago: past the 7-day default, inside a 60-day override.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  await store.issue(row({ interruptId: "old", voidedAt: thirtyDaysAgo }))
  // Voided just now: kept by every window.
  await store.issue(row({ interruptId: "recent", voidedAt: new Date().toISOString() }))
  // Outstanding and long expired: kept by every window — only voided rows go.
  await store.issue(row({ interruptId: "live", expiresAt: "2020-01-01T00:00:00.000Z" }))
  return store
}

describe("b4 approvals prune", () => {
  it("says so and exits cleanly when the app has no approval grant store", async () => {
    const appRoot = await makeApp("export default {}\n")
    const { io: cio, out } = io()
    await runApprovalsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toBe("no approval grant store for this app; nothing to prune")
  })

  it("prunes with the default window and reports the count", async () => {
    const appRoot = await makeApp('export default { approvals: { grants: "optional" } }\n')
    const store = await seededStore(appRoot)
    const { io: cio, out } = io()
    await runApprovalsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toBe("pruned: 1")
    expect((await store.listForThread("t")).map((r) => r.interruptId).sort()).toEqual([
      "live",
      "recent",
    ])
  })

  it("a consumed grant whose prompt is still parked is never pruned", async () => {
    // A resume consumes the row before the resumed run executes; if that run
    // failed the prompt is still parked on a consumed, unvoided row. Deleting
    // it would leave the prompt with no row, which resumes ungated under
    // "optional". Only the void — the thread moving past the prompt — can
    // make the row prunable.
    const appRoot = await makeApp('export default { approvals: { grants: "optional" } }\n')
    const store = await seededStore(appRoot)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    await store.issue(
      row({
        interruptId: "stuck",
        consumedAt: thirtyDaysAgo,
        consumedDecision: "once",
        voidedAt: null,
      }),
    )
    const { io: cio, out } = io()
    await runApprovalsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toBe("pruned: 1")
    expect((await store.listForThread("t")).map((r) => r.interruptId).sort()).toEqual([
      "live",
      "recent",
      "stuck",
    ])
  })

  it("honours approvals.grantRetentionMs from the config", async () => {
    const sixtyDays = 60 * 24 * 60 * 60 * 1000
    const appRoot = await makeApp(
      `export default { approvals: { grants: "optional", grantRetentionMs: ${sixtyDays} } }\n`,
    )
    const store = await seededStore(appRoot)
    const { io: cio, out } = io()
    await runApprovalsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toBe("pruned: 0")
    expect((await store.listForThread("t")).length).toBe(3)
  })

  it("--retention <ms> overrides the window for one pass", async () => {
    const appRoot = await makeApp('export default { approvals: { grants: "optional" } }\n')
    await seededStore(appRoot)
    const { io: cio, out } = io()
    await runApprovalsCommand(
      ["prune", "--retention", String(60 * 24 * 60 * 60 * 1000)],
      { cwd: appRoot },
      cio,
    )
    expect(out.join("\n")).toBe("pruned: 0")
  })

  it("still prunes an existing store file after grants were switched off", async () => {
    const appRoot = await makeApp("export default {}\n")
    const store = await seededStore(appRoot)
    const { io: cio, out } = io()
    await runApprovalsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toBe("pruned: 1")
    expect((await store.listForThread("t")).map((r) => r.interruptId).sort()).toEqual([
      "live",
      "recent",
    ])
  })

  it("rejects an invalid --retention, a missing value, an unknown flag and an unknown subcommand", async () => {
    const appRoot = await makeApp('export default { approvals: { grants: "optional" } }\n')
    const { io: cio } = io()
    for (const argv of [
      ["prune", "--retention", "0"],
      ["prune", "--retention", "1.5"],
      ["prune", "--retention", "abc"],
      ["prune", "--retention"],
      ["prune", "--bogus"],
      ["sweep"],
      [],
    ]) {
      await expect(runApprovalsCommand(argv, { cwd: appRoot }, cio)).rejects.toBeInstanceOf(
        CliError,
      )
    }
  })

  it("fails on a mistyped grantRetentionMs in the config, like the server boot does", async () => {
    const appRoot = await makeApp(
      'export default { approvals: { grants: "optional", grantRetentionMs: "7d" } }\n',
    )
    const { io: cio } = io()
    await expect(runApprovalsCommand(["prune"], { cwd: appRoot }, cio)).rejects.toThrow(
      /grantRetentionMs/,
    )
  })

  it("fails on a configured grantStore that is not a store, like the server boot does", async () => {
    const store = createMemoryInterruptGrantStore()
    const { prune: _omitted, ...withoutPrune } = store
    ;(globalThis as Record<string, unknown>)[STORE_KEY] = withoutPrune
    const appRoot = await makeApp(
      `export default { approvals: { grants: "optional", grantStore: globalThis.${STORE_KEY} } }\n`,
    )
    const { io: cio } = io()
    await expect(runApprovalsCommand(["prune"], { cwd: appRoot }, cio)).rejects.toThrow(
      /missing prune/,
    )
  })
})
