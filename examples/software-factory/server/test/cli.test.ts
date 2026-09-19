import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
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

/**
 * The command line builds the real adapters, so these tests exercise exactly what an
 * operator gets — including the real workspace reader, over a real sandbox provider. The
 * worker here is a fake whose threads never had a sandbox at all, so the read fails with
 * "no workspace storage for this thread" and the work order settles as
 * `verification_inconclusive` with a `workspace_unreadable` event. That is the point of the
 * assertion: an absent workspace is the controller admitting it does not know, never a
 * verdict, and never an empty candidate. The joined path against a real builder's real
 * workspace is the Docker-gated `end-to-end.integration.test.ts`.
 */
async function boot() {
  dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
  const env = {
    ...process.env,
    FACTORY_WORKER_URL: fake.baseUrl,
    FACTORY_STATE_DIR: join(dir, "state"),
    // A rung 0 environment that still sets the retired variables must keep starting.
    FACTORY_WORKER_OUTBOX: join(dir, "outbox"),
    FACTORY_RECEIPT_WAIT_MS: "2000",
  }
  const cli = async (...args: string[]) => {
    const { stdout, stderr } = await run(process.execPath, [tsxBin, cliEntry, ...args], {
      env,
      cwd: packageRoot,
    })
    return { json: JSON.parse(stdout), stderr }
  }
  return cli
}

describe("cli", () => {
  it("creates, dispatches, shows, lists and reports evidence as JSON", async () => {
    const cli = await boot()
    const { json: created } = await cli("create", "--task", "cli-flags")
    expect(created.state).toBe("received")

    const { json: settled } = await cli("dispatch", created.id, "--wait")
    // The fake worker's thread has no workspace storage, so the reader refuses rather than
    // reporting an empty workspace: the controller says it does not know.
    expect(settled.state).toBe("blocked")
    expect(settled.blockedReason).toBe("verification_inconclusive")
    expect(settled.bundleDigest).toBeNull()

    const { json: events } = await cli("events", created.id)
    expect(events.map((e: { type: string }) => e.type)).toContain("workspace_unreadable")

    const { json: shown } = await cli("show", created.id)
    expect(shown.id).toBe(created.id)

    const { json: list } = await cli("list")
    expect(list).toHaveLength(1)

    const { json: evidence } = await cli("evidence", created.id)
    expect(evidence).toEqual({ candidate: null, receipt: null, bundle: null })
  }, 60_000)

  it("exits non-zero on a refused command", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const env = {
      ...process.env,
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
    }
    const { stdout } = await run(
      process.execPath,
      [tsxBin, cliEntry, "create", "--task", "cli-flags"],
      { env, cwd: packageRoot },
    )
    const { id } = JSON.parse(stdout)
    await expect(
      run(
        process.execPath,
        [tsxBin, cliEntry, "approve", id, "--revision", "0", "--bundle", "0".repeat(64)],
        { env, cwd: packageRoot },
      ),
    ).rejects.toMatchObject({ code: 1 })
  }, 60_000)
})
