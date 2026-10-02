import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ClientToolCallRecord, createMemoryClientToolCallStore } from "@b4run/sdk"
import { createClientToolCallStore } from "@b4run/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"
import { runClientToolsCommand } from "../src/commands/client-tools.ts"
import { CliError } from "../src/lib/output.ts"

const tempDirs: string[] = []
/** The config string reaches an in-process store through this global, as agui-client-tools.test.ts does. */
const STORE_KEY = "__b4ClientToolsCommandTestStore"
afterEach(async () => {
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function makeApp(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b4-client-tools-cmd-"))
  tempDirs.push(root)
  await writeFile(
    join(root, "package.json"),
    '{ "name": "client-tools-temp-app", "type": "module" }\n',
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

const row = (over: Partial<ClientToolCallRecord>): ClientToolCallRecord => ({
  threadId: "t",
  toolCallId: "c",
  interruptId: "client-c",
  toolName: "openPanel",
  runId: "r",
  routeId: "/chat#agent",
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  answeredAt: null,
  result: null,
  voidedAt: null,
  ...over,
})

async function seededStore(appRoot: string) {
  const path = join(appRoot, ".b4/client-tool-calls.sqlite")
  await mkdir(join(appRoot, ".b4"), { recursive: true })
  const store = createClientToolCallStore({ path })
  // Voided 30 days ago: past the 7-day default, inside a 60-day override.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  await store.issue(row({ toolCallId: "old", voidedAt: thirtyDaysAgo }))
  // Voided just now: kept by every window.
  await store.issue(row({ toolCallId: "recent", voidedAt: new Date().toISOString() }))
  // Outstanding, never expires: kept by every window.
  await store.issue(row({ toolCallId: "live" }))
  return store
}

describe("b4 client-tools prune", () => {
  it("says so and exits cleanly when the app has no client tool store", async () => {
    const appRoot = await makeApp("export default {}\n")
    const { io: cio, out } = io()
    await runClientToolsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toMatch(/no client tool store/)
  })

  it("prunes with the default window and reports the count", async () => {
    const appRoot = await makeApp(
      'export default { server: { agui: { clientTools: ["/chat"] } } }\n',
    )
    const store = await seededStore(appRoot)
    const { io: cio, out } = io()
    await runClientToolsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toBe("pruned: 1")
    expect((await store.listForThread("t")).map((r) => r.toolCallId).sort()).toEqual([
      "live",
      "recent",
    ])
  })

  it("honours server.agui.clientToolRetentionMs from the config", async () => {
    const sixtyDays = 60 * 24 * 60 * 60 * 1000
    const appRoot = await makeApp(
      `export default { server: { agui: { clientTools: ["/chat"], clientToolRetentionMs: ${sixtyDays} } } }\n`,
    )
    const store = await seededStore(appRoot)
    const { io: cio, out } = io()
    await runClientToolsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toBe("pruned: 0")
    expect((await store.listForThread("t")).length).toBe(3)
  })

  it("--retention <ms> overrides the window for one pass", async () => {
    const appRoot = await makeApp(
      'export default { server: { agui: { clientTools: ["/chat"] } } }\n',
    )
    await seededStore(appRoot)
    const { io: cio, out } = io()
    await runClientToolsCommand(
      ["prune", "--retention", String(60 * 24 * 60 * 60 * 1000)],
      { cwd: appRoot },
      cio,
    )
    expect(out.join("\n")).toBe("pruned: 0")
  })

  it("rejects an invalid --retention, a missing value, an unknown flag and an unknown subcommand", async () => {
    const appRoot = await makeApp(
      'export default { server: { agui: { clientTools: ["/chat"] } } }\n',
    )
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
      await expect(runClientToolsCommand(argv, { cwd: appRoot }, cio)).rejects.toBeInstanceOf(
        CliError,
      )
    }
  })

  it("fails on a mistyped clientToolRetentionMs in the config, like the server boot does", async () => {
    const appRoot = await makeApp(
      'export default { server: { agui: { clientTools: ["/chat"], clientToolRetentionMs: "7d" } } }\n',
    )
    const { io: cio } = io()
    await expect(runClientToolsCommand(["prune"], { cwd: appRoot }, cio)).rejects.toThrow(
      /clientToolRetentionMs/,
    )
  })

  it("fails on a configured clientToolStore that is not a store, like the server boot does", async () => {
    const store = createMemoryClientToolCallStore()
    const { prune: _omitted, ...withoutPrune } = store
    ;(globalThis as Record<string, unknown>)[STORE_KEY] = withoutPrune
    const appRoot = await makeApp(
      `export default { server: { agui: { clientTools: ["/chat"], clientToolStore: globalThis.${STORE_KEY} } } }\n`,
    )
    const { io: cio } = io()
    await expect(runClientToolsCommand(["prune"], { cwd: appRoot }, cio)).rejects.toThrow(
      /missing prune/,
    )
  })
})
