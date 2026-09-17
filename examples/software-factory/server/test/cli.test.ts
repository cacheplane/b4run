import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"

const run = promisify(execFile)
// Resolved from the package's own node_modules rather than relying on `pnpm` being on PATH
// under vitest (it frequently is not in a spawned-child context). `.bin/tsx` is a shell shim
// that `execFile(process.execPath, ...)` cannot run directly, so use tsx's own JS entry point.
const tsxBin = join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs")
const cliEntry = join(import.meta.dirname, "../src/cli.ts")
const packageRoot = join(import.meta.dirname, "..")

let dir: string
let fake: FakeWorker
afterEach(async () => {
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("cli", () => {
  it("creates, dispatches, shows, approves and lists as JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
    mkdirSync(join(dir, "outbox"), { recursive: true })
    fake = await createFakeWorker({ outboxDir: join(dir, "outbox") })
    const env = {
      ...process.env,
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_WORKER_OUTBOX: join(dir, "outbox"),
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_RECEIPT_WAIT_MS: "2000",
    }
    const cli = async (...args: string[]) => {
      const { stdout } = await run(process.execPath, [tsxBin, cliEntry, ...args], {
        env,
        cwd: packageRoot,
      })
      return JSON.parse(stdout)
    }
    const created = await cli("create", "--task", "cli-flags")
    expect(created.state).toBe("received")
    const dispatched = await cli("dispatch", created.id, "--wait")
    expect(dispatched.state).toBe("awaiting_approval")
    const approved = await cli(
      "approve",
      created.id,
      "--revision",
      String(dispatched.revision),
      "--digest",
      dispatched.candidateDigest,
    )
    expect(approved.state).toBe("exported")
    const list = await cli("list")
    expect(list).toHaveLength(1)
    const events = await cli("events", created.id)
    expect(events.map((e: { type: string }) => e.type)).toContain("delivery_observed")
  }, 60_000)

  it("exits non-zero on a refused command", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
    mkdirSync(join(dir, "outbox"), { recursive: true })
    fake = await createFakeWorker({ outboxDir: join(dir, "outbox") })
    const env = {
      ...process.env,
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_WORKER_OUTBOX: join(dir, "outbox"),
      FACTORY_STATE_DIR: join(dir, "state"),
    }
    const { stdout } = await run(
      process.execPath,
      [tsxBin, cliEntry, "create", "--task", "cli-flags"],
      {
        env,
        cwd: packageRoot,
      },
    )
    const { id } = JSON.parse(stdout)
    await expect(
      run(
        process.execPath,
        [tsxBin, cliEntry, "approve", id, "--revision", "0", "--digest", "0".repeat(64)],
        { env, cwd: packageRoot },
      ),
    ).rejects.toMatchObject({ code: 1 })
  }, 60_000)
})
