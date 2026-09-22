import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { BuilderManifestSchema } from "../src/lib/builder-manifest.ts"
import { openRegistryReader } from "../src/lib/registry/reader.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { type ServedController, serveController } from "./serve-controller.ts"

const run = promisify(execFile)
// Resolved from the package's own node_modules rather than relying on `pnpm` being on PATH
// under vitest (it frequently is not in a spawned-child context). `.bin/tsx` is a shell shim
// that `execFile(process.execPath, ...)` cannot run directly, so use tsx's own JS entry point.
const tsxBin = join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs")
const cliEntry = join(import.meta.dirname, "../src/cli.ts")
const packageRoot = join(import.meta.dirname, "..")

let dir: string
// Undefined for the tests that serve nothing, and cleared after every test so a later one
// cannot close an already-closed controller.
let served: ServedController | undefined
afterEach(async () => {
  await served?.close()
  served = undefined
  rmSync(dir, { recursive: true, force: true })
})

interface Spawned {
  readonly promise: Promise<{ stdout: string; stderr: string }>
}

/**
 * The CLI as an operator runs it: a separate process, talking to a controller over HTTP and
 * reading the registry read-only from the state directory. Nothing in the child builds a
 * Factory, so nothing in the child needs a worker, a container or a builder installation —
 * the in-process controller owns all of that, with the fakes `serveController` injects.
 */
async function boot(
  worker: Parameters<typeof serveController>[1] = {},
  overrides: Parameters<typeof serveController>[2] = {},
) {
  dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
  served = await serveController(dir, worker, overrides)
  const env = {
    ...process.env,
    FACTORY_CONTROLLER_URL: served.url,
    FACTORY_STATE_DIR: served.stateDir,
  }
  const spawn = (...args: string[]): Spawned => {
    const promise = run(process.execPath, [tsxBin, cliEntry, ...args], { env, cwd: packageRoot })
    // A child spawned and not awaited yet (the dispatch the cancel test interrupts) exits
    // non-zero while the test is doing something else; without a handler attached here that
    // is an unhandled rejection. `failing` attaches its own handler to the same promise.
    promise.catch(() => undefined)
    return { promise }
  }
  const cli = async (...args: string[]) => {
    const { stdout, stderr } = await spawn(...args).promise
    return { json: JSON.parse(stdout), stderr }
  }
  return { cli, spawn, env, stateDir: served.stateDir }
}

/** The exit-1 half of the contract: the body is still JSON on stdout. */
async function failing(promise: Promise<{ stdout: string; stderr: string }>) {
  const error = await promise.then(
    () => undefined,
    (e: { code?: number; stdout?: string; stderr?: string }) => e,
  )
  expect(error, "expected the command to exit non-zero").toBeDefined()
  expect(error?.code).toBe(1)
  return { stdout: error?.stdout ?? "", stderr: error?.stderr ?? "" }
}

async function pollState(
  stateDir: string,
  id: string,
  done: (state: string | undefined) => boolean,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  let state: string | undefined
  while (Date.now() < deadline) {
    const reader = openRegistryReader(join(stateDir, "registry.sqlite"))
    try {
      state = reader.show(id)?.state
    } finally {
      reader.close()
    }
    if (done(state)) return state
    await new Promise((r) => setTimeout(r, 25))
  }
  return state
}

describe("cli", () => {
  it("creates, dispatches while tailing the journal, and reads rows, events and evidence", async () => {
    const { cli } = await boot()
    const { json: created } = await cli("create", "--task", "cli-flags")
    expect(created).toMatchObject({ ok: true, state: "received" })
    const id = created.row.id as string

    const { json: settled, stderr } = await cli("dispatch", id)
    expect(settled).toMatchObject({ ok: true })
    expect(settled.row.state).toBe("awaiting_approval")
    // The tail is the point of the read-only reader: the operator watches the run through
    // the registry while the request that drives it is still open.
    expect(stderr).toContain('"type":"transition"')

    const { json: shown } = await cli("show", id)
    expect(shown.id).toBe(id)
    expect(shown.state).toBe("awaiting_approval")

    const { json: events } = await cli("events", id)
    expect(events.map((e: { type: string }) => e.type)).toContain("created")

    const { json: list } = await cli("list")
    expect(list).toHaveLength(1)

    const { json: evidence } = await cli("evidence", id)
    expect(evidence.candidate).not.toBeNull()
    expect(evidence.bundle).not.toBeNull()
    expect(evidence.receipt).not.toBeNull()

    const { json: reconciled } = await cli("reconcile")
    expect(reconciled).toMatchObject({ ok: true })
  }, 90_000)

  it("exits non-zero with the refusal on stdout when a command is refused", async () => {
    const { cli, spawn } = await boot()
    const { json: created } = await cli("create", "--task", "cli-flags")
    const { stdout } = await failing(
      spawn("approve", created.row.id, "--revision", "0", "--bundle", "0".repeat(64)).promise,
    )
    expect(JSON.parse(stdout)).toMatchObject({ ok: false })
  }, 90_000)

  it("exits non-zero when the dispatch settles blocked", async () => {
    // A failing receipt is the shape a dispatching script most needs to be told about: the
    // route returns ok, the run finished, and the result is not reviewable.
    const { cli, spawn } = await boot({}, { verifier: createFakeVerifier({ verdict: "fail" }) })
    const { json: created } = await cli("create", "--task", "cli-flags")
    const { stdout } = await failing(spawn("dispatch", created.row.id).promise)
    const outcome = JSON.parse(stdout)
    expect(outcome.row.state).toBe("blocked")
    expect(outcome.row.blockedReason).toBe("verification_failed")
  }, 90_000)

  it("cancels a live dispatch through the runtime, and the dispatch reports run_cancelled", async () => {
    const { cli, spawn, stateDir } = await boot({ run: "hang" })
    const { json: created } = await cli("create", "--task", "cli-flags")
    const id = created.row.id as string

    // Not awaited: this is the run the cancel has to reach into.
    const dispatching = spawn("dispatch", id).promise
    expect(
      await pollState(stateDir, id, (state) => state === "dispatched" || state === "running"),
    ).toMatch(/^(dispatched|running)$/)

    const { json: cancelled } = await cli("cancel", id)
    expect(cancelled.state).toMatch(/^(cancel_requested|cancelled)$/)

    const { stdout } = await failing(dispatching)
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, refusal: "run_cancelled" })
    expect(await pollState(stateDir, id, (state) => state === "cancelled")).toBe("cancelled")
  }, 90_000)

  it("reads without a controller, and refuses to write without one", async () => {
    const { cli, env } = await boot()
    const { json: created } = await cli("create", "--task", "cli-flags")
    const id = created.row.id as string
    const { FACTORY_CONTROLLER_URL, ...readOnlyEnv } = env
    const { stdout } = await run(process.execPath, [tsxBin, cliEntry, "show", id], {
      env: readOnlyEnv,
      cwd: packageRoot,
    })
    expect(JSON.parse(stdout).id).toBe(id)
    const failed = await failing(
      run(process.execPath, [tsxBin, cliEntry, "create", "--task", "cli-flags"], {
        env: readOnlyEnv,
        cwd: packageRoot,
      }),
    )
    expect(failed.stderr).toContain("FACTORY_CONTROLLER_URL")
  }, 90_000)

  it("writes a builder manifest without a controller, a registry or a Factory", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
    // Deliberately neither variable: a command that still needed one would fail here.
    const { FACTORY_CONTROLLER_URL, FACTORY_STATE_DIR, FACTORY_WORKER_URL, ...rest } = process.env
    const out = join(dir, "manifests")
    const { stdout } = await run(
      process.execPath,
      [tsxBin, cliEntry, "builder-manifest", "--task", "cli-flags", "--out", out],
      { env: rest, cwd: packageRoot },
    )
    const { path } = JSON.parse(stdout)
    expect(path).toBe(join(out, "cli-flags.json"))
    const manifest = BuilderManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    expect(manifest.taskId).toBe("cli-flags")
    expect(manifest.target.policy.network.mode).toBe("deny")
  }, 60_000)
})
