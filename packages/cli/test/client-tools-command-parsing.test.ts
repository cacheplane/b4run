import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ClientToolCallRecord } from "@b4run/sdk"
import { createClientToolCallStore } from "@b4run/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"

import { createProgram } from "../src/index.js"
import type { CommandIo } from "../src/lib/output.js"

/**
 * `b4 client-tools` is registered as `client-tools [subcommand] [args...]` with
 * `passThroughOptions()`, so `prune --retention <ms>` has to survive commander's own
 * option parsing before the handler ever sees it. The rest of the client-tools suite
 * calls `runClientToolsCommand([...])` directly, which skips commander entirely —
 * these tests drive the actual program.
 */
const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

function collectIo(): { io: CommandIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CommandIo = {
    stderr: (message: string) => {
      stderr.push(message)
    },
    stdout: (message: string) => {
      stdout.push(message)
    },
  }
  return { io, stdout, stderr }
}

/** An app opted in to client tools whose SQLite store holds one row voided 11 minutes ago. */
async function seededApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-client-tools-parse-"))
  tempDirs.push(appRoot)
  await writeFile(
    join(appRoot, "package.json"),
    '{ "name": "client-tools-parse-temp-app", "type": "module" }\n',
  )
  await writeFile(
    join(appRoot, "b4.config.ts"),
    'export default { server: { agui: { clientTools: ["/chat"] } } }\n',
  )
  await mkdir(join(appRoot, ".b4"), { recursive: true })
  const store = createClientToolCallStore({ path: join(appRoot, ".b4/client-tool-calls.sqlite") })
  const record: ClientToolCallRecord = {
    threadId: "t",
    toolCallId: "old",
    interruptId: "client-old",
    toolName: "openPanel",
    runId: "r",
    routeId: "/chat#agent",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    answeredAt: null,
    result: null,
    voidedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    kind: "client",
    settledAt: null,
    parentToolCallId: null,
  }
  await store.issue(record)
  return appRoot
}

describe("b4 client-tools flag parsing", () => {
  it("passes `prune --retention <ms>` through to the handler, after the command-level --cwd", async () => {
    const appRoot = await seededApp()
    const { io, stdout, stderr } = collectIo()
    const program = createProgram(io)

    await program.parseAsync([
      "node",
      "b4",
      "client-tools",
      "--cwd",
      appRoot,
      "prune",
      "--retention",
      "1",
    ])

    expect(stderr.join("")).not.toMatch(/unknown option/)
    // `--retention 1` reached the handler: the 10-minute TTL floor governs the
    // window, so a row voided 11 minutes ago goes (the 7-day default would keep it).
    expect(stdout.join("")).toContain("pruned: 1")
  })
})

describe("b4 client-tools --help", () => {
  it("lists the prune subcommand and its flag", async () => {
    const { io, stdout } = collectIo()
    const program = createProgram(io)

    // commander's exitOverride turns `--help` into a thrown CommanderError after it
    // has already written the help text.
    await expect(program.parseAsync(["node", "b4", "client-tools", "--help"])).rejects.toThrow()

    const help = stdout.join("")
    expect(help).toContain("prune [--retention <ms>]")
    expect(help).toContain("--cwd <path>")
  })
})
