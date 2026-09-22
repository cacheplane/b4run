import { execFile } from "node:child_process"
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { BuilderManifestSchema } from "../src/lib/builder-manifest.ts"
import { openRegistryReader } from "../src/lib/registry/reader.ts"
import { tasksDir } from "../src/lib/targets/catalog.ts"
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
  controllerEnv: Parameters<typeof serveController>[3] = {},
) {
  dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
  served = await serveController(dir, worker, overrides, controllerEnv)
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

  it("exits non-zero when the budget cancels the dispatch", async () => {
    // The other end a dispatch can settle at without being refused: the run never finished,
    // the ticker spent its budget, and the row is `blocked`. A script must not read that as
    // a delivered change either.
    const { cli, spawn } = await boot({ run: "hang" }, {}, { FACTORY_MAX_ACTIVE_MS: "1000" })
    const { json: created } = await cli("create", "--task", "cli-flags")
    const id = created.row.id as string
    const { stdout } = await failing(spawn("dispatch", id).promise)
    const outcome = JSON.parse(stdout)
    expect(outcome.ok).toBe(false)
    // The route returns as soon as the row leaves the active states, which is the moment the
    // budget cancel is requested; whether the worker has confirmed the run ended by then is
    // a race, and both answers are the same news for the operator.
    expect(outcome.row.state).toMatch(/^(cancel_requested|blocked)$/)
    if (outcome.row.state === "blocked") expect(outcome.row.blockedReason).toBe("budget_exhausted")
    const { json: events } = await cli("events", id)
    // The budget is what ended it, not an operator: the transition names the event.
    expect(
      events.map((e: { payload: { event?: string } }) => e.payload.event).filter(Boolean),
    ).toContain("budget_exhausted")
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

  /** A `gh` that answers `issue view` with a fixed issue and refuses everything else. */
  function stubGh(issue: { title: string; body: string; url: string }): string {
    const path = join(dir, "gh")
    writeFileSync(
      path,
      `#!/bin/sh
case "$1 $2" in
  "issue view") printf '%s\\n' '${JSON.stringify(issue)}' ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`,
    )
    chmodSync(path, 0o755)
    return path
  }

  /** A repository whose `origin` is itself, so a shallow fetch of main works offline. */
  async function localRepo(): Promise<{ root: string; head: string }> {
    const root = join(dir, "repo")
    const git = (...args: string[]) =>
      run("git", ["-C", root, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      })
    await run("git", ["init", "-b", "main", root])
    writeFileSync(join(root, "README.md"), "target\n")
    await git("-c", "user.name=t", "-c", "user.email=t@t", "add", "README.md")
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
    await git("remote", "add", "origin", root)
    const { stdout } = await git("rev-parse", "HEAD")
    return { root, head: stdout.trim() }
  }

  it("creates from an issue through a stubbed gh and a local target repository", async () => {
    const { cli, env } = await boot()
    const gh = stubGh({ title: "Fix the flag", body: "Body\n", url: "https://github.com/x/778" })
    const { root, head } = await localRepo()
    const issueEnv = { ...env, FACTORY_GH: gh, FACTORY_REPO_ROOT: root }
    const { stdout } = await run(
      process.execPath,
      [tsxBin, cliEntry, "create", "--issue", "778", "--repo", "cacheplane/b4run"],
      { env: issueEnv, cwd: packageRoot },
    )
    const created = JSON.parse(stdout)
    expect(created).toMatchObject({ ok: true, state: "received" })
    expect(created.row.origin).toMatchObject({
      kind: "issue",
      repository: "cacheplane/b4run",
      number: 778,
    })
    expect(created.row.origin.bodyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(created.row.pin).toBe(head)
    expect(
      readFileSync(join(served?.stateDir ?? "", "tasks", created.row.id, "issue.md"), "utf8"),
    ).toBe("# Fix the flag (cacheplane/b4run#778)\n\nBody\n")
    const { json: shown } = await cli("show", created.row.id)
    expect(shown.pin).toBe(head)

    const both = await failing(
      run(process.execPath, [tsxBin, cliEntry, "create", "--task", "cli-flags", "--issue", "778"], {
        env: issueEnv,
        cwd: packageRoot,
      }),
    )
    expect(both.stderr).toContain("not both")
    const neither = await failing(
      run(process.execPath, [tsxBin, cliEntry, "create"], { env: issueEnv, cwd: packageRoot }),
    )
    expect(neither.stderr).toContain("--task or --issue")
    const notANumber = await failing(
      run(process.execPath, [tsxBin, cliEntry, "create", "--issue", "seven"], {
        env: issueEnv,
        cwd: packageRoot,
      }),
    )
    expect(notANumber.stderr).toContain("positive integer")
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

  it("writes a builder manifest for a task generated under FACTORY_STATE_DIR", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
    const { FACTORY_CONTROLLER_URL, FACTORY_WORKER_URL, ...rest } = process.env
    // A generated task: the shipped one copied under a work-order id, minus reference.patch.
    const generated = join(dir, "state", "tasks", "wo-0123456789abcdef")
    cpSync(join(tasksDir, "cli-flags"), generated, { recursive: true })
    rmSync(join(generated, "reference.patch"))
    const manifest = JSON.parse(readFileSync(join(generated, "task.json"), "utf8"))
    writeFileSync(
      join(generated, "task.json"),
      JSON.stringify({ ...manifest, id: "wo-0123456789abcdef" }),
    )
    const out = join(dir, "manifests")
    const { stdout } = await run(
      process.execPath,
      [tsxBin, cliEntry, "builder-manifest", "--task", "wo-0123456789abcdef", "--out", out],
      { env: { ...rest, FACTORY_STATE_DIR: join(dir, "state") }, cwd: packageRoot },
    )
    const { path } = JSON.parse(stdout)
    expect(path).toBe(join(out, "wo-0123456789abcdef.json"))
    expect(BuilderManifestSchema.parse(JSON.parse(readFileSync(path, "utf8"))).taskId).toBe(
      "wo-0123456789abcdef",
    )
  }, 60_000)
})
