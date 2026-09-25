import { execFile, spawn as spawnChild } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { verifySourceBundle } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { BuilderHandoffSchema } from "../src/lib/builder-handoff.ts"
import { openRegistryReader } from "../src/lib/registry/reader.ts"
import { loadTask, tasksDir } from "../src/lib/targets/catalog.ts"
import { openImageRegistry } from "../src/lib/targets/images.ts"
import { fakeImageBuilder } from "./fake-image-builder.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { BAD_DRAFTS, GOOD_DRAFT } from "./intake-fixtures.ts"
import {
  FIRST_DRAFTER_THREAD,
  FIRST_THREAD,
  type ServedController,
  serveController,
} from "./serve-controller.ts"
import { useImages } from "./static-images.ts"

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

/** Poll the journal read-only until `done` holds for its event types; the last types seen. */
async function pollEvents(
  stateDir: string,
  id: string,
  done: (types: readonly string[]) => boolean,
  timeoutMs = 10_000,
): Promise<readonly string[]> {
  const deadline = Date.now() + timeoutMs
  let types: readonly string[] = []
  while (Date.now() < deadline) {
    const reader = openRegistryReader(join(stateDir, "registry.sqlite"))
    try {
      types = reader.events(id).map((e) => e.type)
    } finally {
      reader.close()
    }
    if (done(types)) return types
    await new Promise((r) => setTimeout(r, 25))
  }
  return types
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
    // A catalog work order had no intake, and the evidence says so rather than omitting it.
    expect(evidence.oracleReceipt).toBeNull()

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
    // A budget no real verification fits, so the dispatch refusal that guards it is waived.
    const { cli, spawn } = await boot(
      { run: "hang" },
      { allowBudgetBelowVerifierDeadline: true },
      { FACTORY_MAX_ACTIVE_MS: "1000" },
    )
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

  it("cancels a dispatch the operator cancels while it builds its image", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const imagesDir = mkdtempSync(join(tmpdir(), "factory-cli-images-"))
    const images = openImageRegistry({
      path: join(imagesDir, "images.sqlite"),
      builder,
      platform: "linux/arm64",
    })
    // Configured before the boot: the served controller builds through the registry the
    // process has configured (`serveController`), so the build below is this fake's.
    const restore = useImages(images)
    try {
      const { cli, spawn, stateDir } = await boot()
      const { json: created } = await cli("create", "--task", "cli-flags")
      const id = created.row.id as string
      // Not awaited: this is the dispatch the cancel has to reach, while it waits on the build.
      const dispatching = spawn("dispatch", id).promise
      expect(
        await pollEvents(stateDir, id, (types) => types.includes("image_prepare_started")),
      ).toContain("image_prepare_started")
      expect(await pollState(stateDir, id, () => true)).toBe("received")
      const { json: cancelled } = await cli("cancel", id)
      expect(cancelled).toMatchObject({ ok: true })
      const { stdout } = await failing(dispatching)
      expect(JSON.parse(stdout)).toMatchObject({ ok: false })
      expect(await pollState(stateDir, id, (state) => state === "cancelled")).toBe("cancelled")
      const deadline = Date.now() + 10_000
      while (builder.aborted === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 25))
      expect(builder.aborted).toBe(1)
      expect(builder.requests).toHaveLength(1)
    } finally {
      builder.release()
      restore()
      images.close()
      rmSync(imagesDir, { recursive: true, force: true })
    }
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

  it("replays an issue at --pin without consulting origin/main", async () => {
    const { env } = await boot()
    const gh = stubGh({ title: "Fix the flag", body: "Body\n", url: "https://github.com/x/778" })
    const { root, head: first } = await localRepo()
    const git = (...args: string[]) =>
      run("git", ["-C", root, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      })
    writeFileSync(join(root, "README.md"), "target, fixed\n")
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "fix")
    // An origin that answers nothing: a `git fetch origin main` (resolvePin) or any fetch at
    // all would fail the create, so a pinned create that succeeds consulted neither.
    await git("remote", "set-url", "origin", join(dir, "no-such-origin"))
    const issueEnv = { ...env, FACTORY_GH: gh, FACTORY_REPO_ROOT: root }
    const create = (...args: string[]) =>
      run(
        process.execPath,
        [tsxBin, cliEntry, "create", "--issue", "778", "--repo", "cacheplane/b4run", ...args],
        { env: issueEnv, cwd: packageRoot },
      )

    const created = JSON.parse((await create("--pin", first)).stdout)
    expect(created).toMatchObject({ ok: true, state: "received" })
    expect(created.row.pin).toBe(first)
    expect(created.row.origin).toMatchObject({ kind: "issue", number: 778 })
    // A short sha resolves in the checkout to the same commit.
    const short = JSON.parse((await create("--pin", first.slice(0, 10), "--key", "short")).stdout)
    expect(short.row.pin).toBe(first)
    // Without --pin the same checkout cannot create: origin/main is what it would read.
    const unpinned = await failing(create())
    expect(unpinned.stderr).toContain("git fetch failed")

    const absent = "0123456789abcdef0123456789abcdef01234567"
    const refused = await failing(
      run(
        process.execPath,
        [tsxBin, cliEntry, "create", "--issue", "778", "--repo", "x/y", "--pin", absent],
        { env: { ...issueEnv, FACTORY_NO_FETCH: "1" }, cwd: packageRoot },
      ),
    )
    expect(refused.stderr).toContain(`Issue 778 (replay) pins ${absent}`)
    expect(refused.stderr).toContain("FACTORY_NO_FETCH=1")
    const unknownShort = await failing(create("--pin", "0123456789"))
    expect(unknownShort.stderr).toContain("pass the full 40-hex sha")
    // A branch whose name is hex resolves (refs win over abbreviations) to wherever it points,
    // which is not a commit the argument abbreviates: refused, not recorded as the pin.
    const tip = (await git("rev-parse", "HEAD")).stdout.trim()
    const hexName = tip.startsWith("cafe") ? "beef" : "cafe"
    await git("branch", hexName, "HEAD")
    const hexBranch = await failing(create("--pin", hexName, "--key", "hex-branch"))
    expect(hexBranch.stderr).toContain(`--pin ${hexName} resolved to ${tip}`)
    expect(hexBranch.stderr).toContain("pass the full 40-hex sha")
    const withTask = await failing(
      run(process.execPath, [tsxBin, cliEntry, "create", "--task", "cli-flags", "--pin", first], {
        env: issueEnv,
        cwd: packageRoot,
      }),
    )
    expect(withTask.stderr).toMatch(/--pin.*--issue.*--task/)
  }, 90_000)

  it("drives the intake gate: intake tails and parks, reject-intake redrafts, approve-intake needs the digest", async () => {
    const { cli, spawn } = await boot({}, { verifier: createFakeVerifier({ independent: "fail" }) })
    if (!served) throw new Error("no controller")
    served.workspace.queue(FIRST_DRAFTER_THREAD, [GOOD_DRAFT, GOOD_DRAFT])
    const created = await served.run("create-cli-issue", "/work-orders/create#workflow", {
      origin: {
        kind: "issue",
        repository: "cacheplane/b4run",
        number: 778,
        bodyDigest: "0".repeat(64),
      },
      pin: served.pin,
      issue: { title: "spawnProcess leaks its deadline timer", body: "B" },
    })
    const id = (created.body as { row: { id: string } }).row.id

    const { json: parked, stderr } = await cli("intake", id)
    expect(parked).toMatchObject({ ok: true, state: "awaiting_intake_approval" })
    expect(parked.row.state).toBe("awaiting_intake_approval")
    expect(parked.row.taskDigest).toMatch(/^[a-f0-9]{64}$/)
    // Tailed like a dispatch: the drafter's turn is watched through the registry.
    expect(stderr).toContain('"type":"transition"')
    expect(stderr).toContain("intake_drafted")

    const noNote = await failing(spawn("reject-intake", id).promise)
    expect(noNote.stderr).toContain("--note")
    const wrongDigest = await failing(
      spawn(
        "approve-intake",
        id,
        "--revision",
        String(parked.row.revision),
        "--digest",
        "b".repeat(64),
      ).promise,
    )
    expect(JSON.parse(wrongDigest.stdout)).toMatchObject({
      ok: false,
      message: "Task digest does not match the work order's",
    })

    const { json: redrafted } = await cli("reject-intake", id, "--note", "name the timer")
    expect(redrafted).toMatchObject({ ok: true, state: "awaiting_intake_approval" })
    expect(redrafted.row.intakeAttempts).toBe(2)
    // The redraft's own digest, not the rejected one's: the rejection cleared it.
    expect(redrafted.row.taskDigest).toMatch(/^[a-f0-9]{64}$/)

    // The digest an operator approves is the one `show` prints, not one from an earlier run.
    const { json: shown } = await cli("show", id)
    expect(shown.state).toBe("awaiting_intake_approval")
    const { json: approved } = await cli(
      "approve-intake",
      id,
      "--revision",
      String(shown.revision),
      "--digest",
      shown.taskDigest,
    )
    expect(approved).toMatchObject({ ok: true, state: "received" })
    expect(approved.row.taskDigest).toBe(shown.taskDigest)
    // The proof the approved draft was parked on is evidence an approver can read: the
    // receipt of the SECOND attempt, the one whose draft was approved.
    const { json: evidence } = await cli("evidence", id)
    expect(evidence.oracleReceipt).toMatchObject({ verdict: "fail", workOrderId: id })
    const { json: events } = await cli("events", id)
    const proofs = events.filter((e: { type: string }) => e.type === "oracle_receipt")
    expect(proofs).toHaveLength(2)
    expect(evidence.oracleReceipt.id).toBe(proofs[1].payload.receiptId)
  }, 90_000)

  it("follows the row when an awaiting dispatch's request times out while the work goes on", async () => {
    // A builder turn slower than the request may wait: the injected timeout stands in for
    // undici's 300 s headers timeout on `runs/wait`, which is what ended the live run's CLI.
    const { env, stateDir } = await boot({ frameDelayMs: 1_500 })
    const { stdout: createdOut } = await run(
      process.execPath,
      [tsxBin, cliEntry, "create", "--task", "cli-flags"],
      { env, cwd: packageRoot },
    )
    const id = JSON.parse(createdOut).row.id as string
    const { stdout, stderr } = await run(process.execPath, [tsxBin, cliEntry, "dispatch", id], {
      env: { ...env, FACTORY_CLI_REQUEST_TIMEOUT_MS: "500" },
      cwd: packageRoot,
    })
    expect(stderr).toContain("the request ended before its answer")
    expect(stderr).toContain("following the row in the registry")
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      state: "awaiting_approval",
      message: "Settled as awaiting_approval (read from the registry after the request ended)",
      row: { id, state: "awaiting_approval" },
    })
    expect(await pollState(stateDir, id, () => true)).toBe("awaiting_approval")
  }, 90_000)

  it("follows a dispatch that is still building its image when its request times out", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const imagesDir = mkdtempSync(join(tmpdir(), "factory-cli-images-"))
    const images = openImageRegistry({
      path: join(imagesDir, "images.sqlite"),
      builder,
      platform: "linux/arm64",
    })
    // Configured before the boot, as in the cancel-while-building test: the served controller
    // builds through this registry, and the test's own catalog reads agree with it.
    const restore = useImages(images)
    try {
      const { env, stateDir } = await boot()
      const { stdout: createdOut } = await run(
        process.execPath,
        [tsxBin, cliEntry, "create", "--task", "cli-flags"],
        { env, cwd: packageRoot },
      )
      const id = JSON.parse(createdOut).row.id as string
      // The build outlives the request (500 ms) and the arrival window (1 s): only the journal
      // says the request arrived and the work goes on.
      setTimeout(() => builder.release(), 3_000)
      const { stdout, stderr } = await run(process.execPath, [tsxBin, cliEntry, "dispatch", id], {
        env: {
          ...env,
          FACTORY_CLI_REQUEST_TIMEOUT_MS: "500",
          FACTORY_CLI_ARRIVAL_WINDOW_MS: "1000",
        },
        cwd: packageRoot,
      })
      expect(stderr).toContain("the request ended before its answer")
      expect(stderr).toContain("image_prepare_started")
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, state: "awaiting_approval" })
      expect(await pollState(stateDir, id, () => true)).toBe("awaiting_approval")
    } finally {
      builder.release()
      restore()
      images.close()
      rmSync(imagesDir, { recursive: true, force: true })
    }
  }, 90_000)

  it("reads back a dispatch refused after its image build, with the row still received", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    builder.failNext("docker build failed")
    const imagesDir = mkdtempSync(join(tmpdir(), "factory-cli-images-"))
    const images = openImageRegistry({
      path: join(imagesDir, "images.sqlite"),
      builder,
      platform: "linux/arm64",
    })
    const restore = useImages(images)
    try {
      const { env, stateDir } = await boot()
      const { stdout: createdOut } = await run(
        process.execPath,
        [tsxBin, cliEntry, "create", "--task", "cli-flags"],
        { env, cwd: packageRoot },
      )
      const id = JSON.parse(createdOut).row.id as string
      // The build fails only after the request (500 ms) and the arrival window (1 s) are gone.
      setTimeout(() => builder.release(), 3_000)
      const { stdout, stderr } = await failing(
        run(process.execPath, [tsxBin, cliEntry, "dispatch", id], {
          env: {
            ...env,
            FACTORY_CLI_REQUEST_TIMEOUT_MS: "500",
            FACTORY_CLI_ARRIVAL_WINDOW_MS: "1000",
          },
          cwd: packageRoot,
        }),
      )
      expect(stderr).toContain("the request ended before its answer")
      const outcome = JSON.parse(stdout)
      expect(outcome).toMatchObject({ ok: false, state: "received" })
      expect(outcome.message).toMatch(
        /^Refused \(read from the registry after the request ended\): the image of target cli-flags .* could not be built: .*docker build failed/,
      )
      expect(await pollState(stateDir, id, () => true)).toBe("received")
    } finally {
      builder.release()
      restore()
      images.close()
      rmSync(imagesDir, { recursive: true, force: true })
    }
  }, 90_000)

  it("follows an approve past its request timeout: arrival and the export read from the registry", async () => {
    // Approve re-verifies with the row still `awaiting_approval` at its revision (about 20
    // minutes on the `cli` target), so the live run's CLI timed out and a repeat was refused
    // `run_in_flight`. The journal says it arrived, and the row says it exported.
    const verifier = createFakeVerifier({ verdict: "pass" })
    const { cli, env } = await boot({}, { verifier })
    const { json: created } = await cli("create", "--task", "cli-flags")
    const id = created.row.id as string
    const { json: dispatched } = await cli("dispatch", id)
    expect(dispatched.row.state).toBe("awaiting_approval")
    verifier.script = { verdict: "pass", delayMs: 2_000 }
    const { stdout, stderr } = await run(
      process.execPath,
      [
        tsxBin,
        cliEntry,
        "approve",
        id,
        "--revision",
        String(dispatched.row.revision),
        "--bundle",
        dispatched.row.bundleDigest,
      ],
      { env: { ...env, FACTORY_CLI_REQUEST_TIMEOUT_MS: "500" }, cwd: packageRoot },
    )
    expect(stderr).toContain("the request ended before its answer")
    expect(stderr).toContain('"type":"approve_started"')
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      state: "exported",
      message: "Settled as exported (read from the registry after the request ended)",
    })
  }, 90_000)

  it("reports an approve refused after its request timed out, and exits non-zero", async () => {
    const verifier = createFakeVerifier({ verdict: "pass" })
    const { cli, env } = await boot({}, { verifier })
    const { json: created } = await cli("create", "--task", "cli-flags")
    const id = created.row.id as string
    const { json: dispatched } = await cli("dispatch", id)
    // The re-verification fails: the row stays `awaiting_approval`, an active state for the
    // follow, and only the journal's refusal line ends it.
    verifier.script = { verdict: "fail", delayMs: 2_000 }
    const { stdout } = await failing(
      run(
        process.execPath,
        [
          tsxBin,
          cliEntry,
          "approve",
          id,
          "--revision",
          String(dispatched.row.revision),
          "--bundle",
          dispatched.row.bundleDigest,
        ],
        { env: { ...env, FACTORY_CLI_REQUEST_TIMEOUT_MS: "500" }, cwd: packageRoot },
      ),
    )
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      message:
        "Refused (read from the registry after the request ended): Re-verification did not pass: fail",
    })
  }, 90_000)

  it("follows the row past a timed-out intake, with the intake's exit code", async () => {
    const { env } = await boot(
      {},
      {
        verifier: createFakeVerifier({ independent: "fail" }),
        drafter: { frameDelayMs: 1_500, run: "edits_only" },
      },
    )
    if (!served) throw new Error("no controller")
    served.workspace.set(FIRST_DRAFTER_THREAD, BAD_DRAFTS.badTarget as Record<string, string>)
    const created = await served.run("create-cli-timeout", "/work-orders/create#workflow", {
      origin: {
        kind: "issue",
        repository: "cacheplane/b4run",
        number: 778,
        bodyDigest: "0".repeat(64),
      },
      pin: served.pin,
      issue: { title: "T", body: "B" },
    })
    const id = (created.body as { row: { id: string } }).row.id
    const { stdout, stderr } = await failing(
      run(process.execPath, [tsxBin, cliEntry, "intake", id], {
        env: { ...env, FACTORY_CLI_REQUEST_TIMEOUT_MS: "500" },
        cwd: packageRoot,
      }),
    )
    expect(stderr).toContain("the request ended before its answer")
    // Blocked is not intake's success, whichever way the answer arrived: `ok` is the
    // command's success set, as the route decides it, not "the row settled".
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      state: "blocked",
      row: { state: "blocked", blockedReason: "no_target_for_package" },
    })
  }, 90_000)

  it("exits non-zero when an intake settles blocked", async () => {
    const { cli, spawn } = await boot({}, { verifier: createFakeVerifier({ independent: "fail" }) })
    if (!served) throw new Error("no controller")
    // A draft naming a package with no prepared target blocks at once: no redraft can
    // prepare one, so this is the one refusal that never spends a second attempt.
    served.workspace.set(FIRST_DRAFTER_THREAD, BAD_DRAFTS.badTarget as Record<string, string>)
    const created = await served.run("create-cli-blocked", "/work-orders/create#workflow", {
      origin: {
        kind: "issue",
        repository: "cacheplane/b4run",
        number: 778,
        bodyDigest: "0".repeat(64),
      },
      pin: served.pin,
      issue: { title: "T", body: "B" },
    })
    const id = (created.body as { row: { id: string } }).row.id
    const { stdout } = await failing(spawn("intake", id).promise)
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      state: "blocked",
      message: "Intake settled in blocked (no_target_for_package)",
      row: { state: "blocked", blockedReason: "no_target_for_package", intakeAttempts: 1 },
    })
    const { json: shown } = await cli("show", id)
    expect(shown.state).toBe("blocked")
  }, 90_000)

  it("exits non-zero when a rejection exhausts the drafter's attempts", async () => {
    const { cli, spawn } = await boot({}, { verifier: createFakeVerifier({ independent: "fail" }) })
    if (!served) throw new Error("no controller")
    // Two good drafts, two rejections: the default of two attempts is spent by the redraft,
    // so the second rejection has nothing left to start and the work order blocks.
    served.workspace.queue(FIRST_DRAFTER_THREAD, [GOOD_DRAFT, GOOD_DRAFT])
    const created = await served.run("create-cli-exhausted", "/work-orders/create#workflow", {
      origin: {
        kind: "issue",
        repository: "cacheplane/b4run",
        number: 778,
        bodyDigest: "0".repeat(64),
      },
      pin: served.pin,
      issue: { title: "T", body: "B" },
    })
    const id = (created.body as { row: { id: string } }).row.id
    const { json: parked } = await cli("intake", id)
    expect(parked).toMatchObject({ ok: true, state: "awaiting_intake_approval" })
    const { json: redrafted } = await cli("reject-intake", id, "--note", "again")
    expect(redrafted).toMatchObject({ ok: true, row: { intakeAttempts: 2 } })
    const { stdout } = await failing(spawn("reject-intake", id, "--note", "still no").promise)
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      state: "blocked",
      message: "Intake rejected; no drafter attempts remain, the work order is blocked",
      row: { state: "blocked", blockedReason: "intake_attempts_exhausted" },
    })
    // A rejected draft is nobody's: `show` carries no digest and no target for it, and the
    // evidence shows no oracle proof for a draft that is not the row's.
    const { json: shown } = await cli("show", id)
    expect(shown).toMatchObject({ state: "blocked", taskDigest: null, targetId: null })
    const { json: evidence } = await cli("evidence", id)
    expect(evidence.oracleReceipt).toBeNull()
  }, 90_000)

  /** Park a work order for approval through the real controller, and return its id. */
  async function parkedIntake(cli: Awaited<ReturnType<typeof boot>>["cli"], key: string) {
    if (!served) throw new Error("no controller")
    served.workspace.set(FIRST_DRAFTER_THREAD, GOOD_DRAFT as Record<string, string>)
    const created = await served.run(key, "/work-orders/create#workflow", {
      origin: {
        kind: "issue",
        repository: "cacheplane/b4run",
        number: 778,
        bodyDigest: "0".repeat(64),
      },
      pin: served.pin,
      issue: { title: "T", body: "B" },
    })
    const id = (created.body as { row: { id: string } }).row.id
    const { json: parked } = await cli("intake", id)
    expect(parked).toMatchObject({ ok: true, state: "awaiting_intake_approval" })
    return { id, revision: parked.row.revision as number }
  }

  /**
   * `review` as a person runs it at a terminal: `FACTORY_CLI_INTERACTIVE=1` stands in for a
   * TTY on stdin. The answer is typed only once the prompt is on stderr, after `beforeAnswer`
   * (a file edited between display and approval, say) has run.
   */
  async function interactive(
    env: NodeJS.ProcessEnv,
    args: readonly string[],
    answer: string,
    beforeAnswer: () => void = () => undefined,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawnChild(process.execPath, [tsxBin, cliEntry, ...args], {
      env: { ...env, FACTORY_CLI_INTERACTIVE: "1" },
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let answered = false
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
      if (!answered && stderr.includes("first eight hex digits")) {
        answered = true
        beforeAnswer()
        child.stdin.write(`${answer}\n`)
      }
    })
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
    return { code, stdout, stderr }
  }

  it("reviews an intake: shows the draft and its proof, and approves the digest of what it showed", async () => {
    const { cli, spawn, env, stateDir } = await boot(
      {},
      { verifier: createFakeVerifier({ independent: "fail" }) },
    )
    const { id, revision } = await parkedIntake(cli, "create-cli-review")
    const { json: row } = await cli("show", id)
    const digest = row.taskDigest as string
    const taskDir = join(stateDir, "tasks", id)

    // The fake verifier records output digests it never writes: the oracle proof's output is
    // missing, and a review refuses to approve what it could not show unless told explicitly.
    const unseen = await failing(spawn("review", id, "--approve", "--digest", digest).promise)
    expect(unseen.stderr).toContain("NOT IN THE ARTIFACT STORE")
    expect(JSON.parse(unseen.stdout)).toMatchObject({
      ok: false,
      state: "awaiting_intake_approval",
      row: { id, taskDigest: digest },
    })
    expect(JSON.parse(unseen.stdout).message).toContain("--allow-missing-evidence")

    // Without a terminal and without --digest there is nothing to type the prefix into.
    const noTty = await failing(spawn("review", id, "--allow-missing-evidence").promise)
    expect(noTty.stderr).toContain("==> spec.md")
    expect(noTty.stderr).toContain("!!! WARNING: The oracle proof's output")
    expect(JSON.parse(noTty.stdout)).toMatchObject({ ok: false, state: "awaiting_intake_approval" })
    expect(JSON.parse(noTty.stdout).message).toContain("--approve --digest")
    const approveNoDigest = await failing(
      spawn("review", id, "--approve", "--allow-missing-evidence").promise,
    )
    expect(JSON.parse(approveNoDigest.stdout).message).toContain("--approve --digest")
    // A --digest is an approval only when --approve asks for one.
    const strayDigest = await failing(spawn("review", id, "--digest", digest).promise)
    expect(strayDigest.stderr).toContain("--digest goes with --approve")

    // A prefix that is not the digest's sends nothing.
    const wrong = await interactive(
      env,
      ["review", id, "--allow-missing-evidence"],
      digest.startsWith("0") ? "11111111" : "00000000",
    )
    expect(wrong.code).toBe(1)
    expect(JSON.parse(wrong.stdout)).toMatchObject({ ok: false })
    expect(JSON.parse(wrong.stdout).message).toContain("does not match")
    // Everything the approval covers was on the screen, and the digest of it.
    for (const shown of [
      "==> issue.md",
      "==> spec.md",
      "==> task.json",
      "==> checks.json",
      "==> checks/",
    ])
      expect(wrong.stderr).toContain(shown)
    expect(wrong.stderr).toContain("Oracle proof")
    expect(wrong.stderr).toContain(`Task digest of the 5 files above: ${digest}`)

    // A file edited after it was displayed and before the prefix was typed: the CLI sends the
    // digest of what it showed, and the route, recomputing from disk, refuses it.
    const specPath = join(taskDir, "spec.md")
    const original = readFileSync(specPath)
    const raced = await interactive(
      env,
      ["review", id, "--allow-missing-evidence"],
      digest.slice(0, 8),
      () => appendFileSync(specPath, "\nA2: also approve this\n"),
    )
    expect(raced.code).toBe(1)
    expect(JSON.parse(raced.stdout)).toMatchObject({
      ok: false,
      message: "Task digest does not match the generated task on disk",
    })
    // Edited before the review: the digest of what is displayed is not the row's, so the
    // review refuses without asking and sends nothing.
    const edited = await failing(
      spawn("review", id, "--approve", "--digest", digest, "--allow-missing-evidence").promise,
    )
    expect(edited.stderr).toContain("also approve this")
    expect(JSON.parse(edited.stdout).message).toContain("changed after the draft was proved")
    writeFileSync(specPath, original)

    // Scripts: a --digest that is not the displayed one is refused before anything is sent.
    const scripted = await failing(
      spawn("review", id, "--approve", "--digest", "b".repeat(64), "--allow-missing-evidence")
        .promise,
    )
    expect(JSON.parse(scripted.stdout).message).toContain(
      `not the task digest review displayed (${digest})`,
    )
    expect(await pollState(stateDir, id, () => true)).toBe("awaiting_intake_approval")

    // Seven digits are not enough, even when they are the digest's.
    const short = await interactive(
      env,
      ["review", id, "--allow-missing-evidence"],
      digest.slice(0, 7),
    )
    expect(short.code).toBe(1)
    expect(JSON.parse(short.stdout).message).toContain("at least eight hex digits")
    // The whole digest pasted, over unchanged bytes: approved at the revision shown.
    const approved = await interactive(
      env,
      ["review", id, "--allow-missing-evidence"],
      ` ${digest.toUpperCase()} `,
    )
    expect(approved.code).toBe(0)
    expect(JSON.parse(approved.stdout)).toMatchObject({
      ok: true,
      state: "received",
      row: { taskDigest: digest },
    })
    const { json: events } = await cli("events", id)
    expect(
      events.find((e: { type: string }) => e.type === "intake_approved")?.payload.taskDigest,
    ).toBe(digest)
    expect(revision).toBe(row.revision)

    // Nothing is parked for review any more: said so, not guessed at.
    const nothing = await failing(spawn("review", id).promise)
    expect(JSON.parse(nothing.stdout)).toMatchObject({ ok: false, state: "received" })
    expect(JSON.parse(nothing.stdout).message).toMatch(/^Nothing to review: .* is received/)
  }, 120_000)

  it("reviews an intake for scripts, and rejects one with a note", async () => {
    const { cli, spawn } = await boot({}, { verifier: createFakeVerifier({ independent: "fail" }) })
    if (!served) throw new Error("no controller")
    served.workspace.queue(FIRST_DRAFTER_THREAD, [GOOD_DRAFT, GOOD_DRAFT])
    const created = await served.run("create-cli-review-reject", "/work-orders/create#workflow", {
      origin: {
        kind: "issue",
        repository: "cacheplane/b4run",
        number: 778,
        bodyDigest: "0".repeat(64),
      },
      pin: served.pin,
      issue: { title: "T", body: "B" },
    })
    const id = (created.body as { row: { id: string } }).row.id
    await cli("intake", id)

    const noNote = await failing(spawn("review", id, "--reject").promise)
    expect(noNote.stderr).toContain("--note")
    const both = await failing(spawn("review", id, "--approve", "--reject", "--note", "x").promise)
    expect(both.stderr).toContain("not both")

    // --reject is reject-intake: the note is journalled and the redraft awaited.
    const { json: redrafted } = await cli("review", id, "--reject", "--note", "name the timer")
    expect(redrafted).toMatchObject({ ok: true, state: "awaiting_intake_approval" })
    expect(redrafted.row.intakeAttempts).toBe(2)
    const { json: events } = await cli("events", id)
    expect(events.find((e: { type: string }) => e.type === "intake_rejected")?.payload.note).toBe(
      "name the timer",
    )

    // --approve --digest is the scripting contract: the full digest, no prompt.
    const { json: shown } = await cli("show", id)
    const { json: approved } = await cli(
      "review",
      id,
      "--approve",
      "--digest",
      shown.taskDigest,
      "--allow-missing-evidence",
    )
    expect(approved).toMatchObject({ ok: true, state: "received" })
  }, 120_000)

  it("reviews an export: diffs the candidate against the pin, shows the receipt and the bundle, and approves or denies it", async () => {
    const { cli, spawn, env } = await boot()
    // The candidate is the target's file at its pin with one line changed: the review must
    // show that hunk, not the file. `cli-flags` records no pin on the row; its target's is used.
    const target = loadTask("cli-flags").target
    const { stdout: pinned } = await run("git", [
      "-C",
      packageRoot,
      "show",
      `${target.pin}:${target.root}/src/cli.ts`,
    ])
    const lines = pinned.split("\n")
    const last = lines.indexOf("await program.parseAsync(process.argv)")
    expect(last).toBeGreaterThan(5)
    const repaired = pinned.replace(
      "await program.parseAsync(process.argv)",
      'await program.parseAsync(process.argv, { from: "node" })',
    )
    served?.workspace.set(FIRST_THREAD, {
      "src/cli.ts": repaired,
      "test/cli.test.ts": "spec\n",
      "TASK.md": "task\n",
    })
    const dispatchedOrder = async () => {
      const { json: created } = await cli("create", "--task", "cli-flags")
      const id = created.row.id as string
      const { json: dispatched } = await cli("dispatch", id)
      expect(dispatched.row.state).toBe("awaiting_approval")
      return { id, bundle: dispatched.row.bundleDigest as string }
    }
    const first = await dispatchedOrder()
    // The fake verifier records check-output digests it never writes: an export whose receipt
    // output is missing is not approvable as displayed unless the person says so explicitly.
    const unseen = await failing(
      spawn("review", first.id, "--approve", "--digest", first.bundle).promise,
    )
    expect(unseen.stderr).toContain("NOT IN THE ARTIFACT STORE")
    expect(JSON.parse(unseen.stdout)).toMatchObject({
      ok: false,
      state: "awaiting_approval",
      row: { id: first.id, bundleDigest: first.bundle },
    })
    expect(JSON.parse(unseen.stdout).message).toContain(
      "The receipt's check output (visible/output, independent/output)",
    )
    expect(JSON.parse(unseen.stdout).message).toContain("--allow-missing-evidence")
    const wrong = await interactive(
      env,
      ["review", first.id, "--allow-missing-evidence"],
      "zzzzzzzz",
    )
    expect(wrong.stderr).toContain("!!! WARNING: The receipt's check output")
    expect(wrong.code).toBe(1)
    expect(JSON.parse(wrong.stdout).message).toContain("does not match")
    // The hunk around the changed line against the pin, not the whole file; the receipt; and
    // the bundle with its digest.
    expect(wrong.stderr).toContain(`==> src/cli.ts (diff against pin ${target.pin.slice(0, 12)})`)
    expect(wrong.stderr).toContain(`@@ -${last - 2},4 +${last - 2},4 @@`)
    expect(wrong.stderr).toContain("-await program.parseAsync(process.argv)\n")
    expect(wrong.stderr).toContain('+await program.parseAsync(process.argv, { from: "node" })')
    expect(wrong.stderr).not.toContain(lines[0])
    // A pin the object store cannot read: the whole file, and the reason there is no diff.
    const emptyRepo = join(dir, "empty-repo")
    await run("git", ["init", "-q", emptyRepo])
    const fallback = await failing(
      run(process.execPath, [tsxBin, cliEntry, "review", first.id, "--allow-missing-evidence"], {
        env: { ...env, FACTORY_REPO_ROOT: emptyRepo, FACTORY_NO_FETCH: "1" },
        cwd: packageRoot,
      }),
    )
    expect(fallback.stderr).toContain(
      "==> src/cli.ts (the whole file as the export writes it: no diff, because",
    )
    // The catalog loads the pin as `create` does; FACTORY_NO_FETCH=1 keeps it from fetching.
    expect(fallback.stderr).toContain(
      `pins ${target.pin}, which is not in the repository at ${emptyRepo} (FACTORY_NO_FETCH=1, not fetched)`,
    )
    expect(fallback.stderr).toContain(lines[0])
    expect(fallback.stderr).toContain('await program.parseAsync(process.argv, { from: "node" })')
    expect(wrong.stderr).toContain("--- Verification: receipt rc-")
    expect(wrong.stderr).toContain(`Bundle digest of the payload above: ${first.bundle}`)
    const notTheBundle = await failing(
      spawn("review", first.id, "--approve", "--digest", "c".repeat(64), "--allow-missing-evidence")
        .promise,
    )
    expect(JSON.parse(notTheBundle.stdout).message).toContain("not the bundle digest")

    const approved = await interactive(
      env,
      ["review", first.id, "--allow-missing-evidence"],
      first.bundle.slice(0, 8),
    )
    expect(approved.code).toBe(0)
    expect(JSON.parse(approved.stdout)).toMatchObject({ ok: true, state: "exported" })

    // --reject on an export is deny; the deny route takes no note, so the note is echoed.
    // The fake builder names its second thread itself; the repair is scripted under it.
    served?.workspace.set("fake-thread-1", {
      "src/cli.ts": "export const fixed = true\n",
      "test/cli.test.ts": "spec\n",
      "TASK.md": "task\n",
    })
    const second = await dispatchedOrder()
    const { json: denied } = await cli("review", second.id, "--reject", "--note", "wrong fix")
    expect(denied).toMatchObject({ ok: true, state: "denied", note: "wrong fix" })
  }, 120_000)

  /** A TCP server that accepts each connection and drops it unread: the request never arrives. */
  async function dropping(): Promise<{ url: string; server: Server }> {
    const server = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("no port")
    return { url: `http://127.0.0.1:${address.port}`, server }
  }

  it("does not read a reject-intake that never reached the controller as settled", async () => {
    // The review's false success: `reject-intake` starts from `awaiting_intake_approval`, its
    // own success state, so a request lost in transport used to poll once, find the row
    // there, and answer "Settled as awaiting_intake_approval", exit 0.
    const { cli, env, stateDir } = await boot(
      {},
      { verifier: createFakeVerifier({ independent: "fail" }) },
    )
    const { id, revision } = await parkedIntake(cli, "create-cli-lost")
    const { url, server } = await dropping()
    try {
      const { stdout, stderr } = await failing(
        run(process.execPath, [tsxBin, cliEntry, "reject-intake", id, "--note", "redo"], {
          env: { ...env, FACTORY_CONTROLLER_URL: url, FACTORY_CLI_ARRIVAL_WINDOW_MS: "1500" },
          cwd: packageRoot,
        }),
      )
      expect(stderr).toContain("the request ended before its answer")
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        state: "awaiting_intake_approval",
        row: { id, state: "awaiting_intake_approval", revision },
      })
      expect(JSON.parse(stdout).message).toMatch(/^The request did not reach the controller/)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    // Nothing moved: the draft is still parked at the revision the operator read.
    expect(await pollState(stateDir, id, () => true)).toBe("awaiting_intake_approval")
  }, 90_000)

  it("does not poll after a refused connection: nothing was sent", async () => {
    const { cli, env } = await boot({}, { verifier: createFakeVerifier({ independent: "fail" }) })
    const { id } = await parkedIntake(cli, "create-cli-refused")
    // A port nobody listens on: bound, read, closed.
    const { url, server } = await dropping()
    await new Promise((resolve) => server.close(resolve))
    const started = Date.now()
    const { stderr } = await failing(
      run(process.execPath, [tsxBin, cliEntry, "reject-intake", id, "--note", "redo"], {
        env: { ...env, FACTORY_CONTROLLER_URL: url },
        cwd: packageRoot,
      }),
    )
    expect(stderr).not.toContain("following the row")
    expect(stderr).toMatch(/fetch failed/)
    // Well inside the default arrival window: it never waited on the row.
    expect(Date.now() - started).toBeLessThan(30_000)
  }, 90_000)

  it("writes a builder handoff and its source without a controller, a registry or a Factory", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
    // Deliberately neither variable: a command that still needed one would fail here.
    const { FACTORY_CONTROLLER_URL, FACTORY_STATE_DIR, FACTORY_WORKER_URL, ...rest } = process.env
    const out = join(dir, "handoffs")
    const task = loadTask("cli-flags")
    const targetId = task.target.id

    // The per-process target file and the manifest file are retired: one builder serves every
    // target and pin, and each work order's workspace is staged over the Agent Protocol.
    for (const command of ["builder-target", "builder-manifest"]) {
      const retired = await failing(
        run(process.execPath, [tsxBin, cliEntry, command, "--out", dir], {
          env: rest,
          cwd: packageRoot,
        }),
      )
      expect(retired.stderr).toContain(`Unknown command ${command}`)
    }

    // The work order defaults to the task: a lane with no controller names the files itself.
    const { stdout } = await run(
      process.execPath,
      [tsxBin, cliEntry, "builder-handoff", "--task", "cli-flags", "--out", out],
      { env: rest, cwd: packageRoot },
    )
    const written = JSON.parse(stdout)
    expect(written.handoff).toBe(join(out, "cli-flags.handoff.json"))
    expect(written.source).toBe(join(out, "cli-flags.source.json"))
    const handoff = BuilderHandoffSchema.parse(JSON.parse(readFileSync(written.handoff, "utf8")))
    expect(handoff).toMatchObject({ taskId: "cli-flags", workOrderId: "cli-flags", targetId })
    // The target block: the image prepared at the task's pin, and the pin beside it.
    expect(handoff.target.pin).toBe(task.target.pin)
    expect(handoff.target.image).toContain(`:${task.target.pin.slice(0, 12)}-`)
    expect(handoff.target.policy.network.mode).toBe("deny")
    // The source is the body `PUT /workspace/sources/<digest>` takes, under the handoff's digest.
    const source = verifySourceBundle(JSON.parse(readFileSync(written.source, "utf8")))
    expect(source.digest).toBe(handoff.workspace.sourceDigest)
    expect(written.sourceDigest).toBe(source.digest)
    const { stdout: named } = await run(
      process.execPath,
      [
        tsxBin,
        cliEntry,
        "builder-handoff",
        "--task",
        "cli-flags",
        "--work-order",
        "wo-named",
        "--out",
        out,
      ],
      { env: rest, cwd: packageRoot },
    )
    expect(JSON.parse(named).handoff).toBe(join(out, "wo-named.handoff.json"))
    expect(
      BuilderHandoffSchema.parse(
        JSON.parse(readFileSync(join(out, "wo-named.handoff.json"), "utf8")),
      ).workOrderId,
    ).toBe("wo-named")
  }, 60_000)

  it("writes a builder handoff for a task generated under FACTORY_STATE_DIR", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-cli-"))
    const { FACTORY_CONTROLLER_URL, FACTORY_WORKER_URL, ...rest } = process.env
    // A generated task: the shipped one copied under a work-order id, minus reference.patch.
    const generated = join(dir, "state", "tasks", "wo-0123456789abcdef")
    cpSync(join(tasksDir, "cli-flags"), generated, { recursive: true })
    rmSync(join(generated, "reference.patch"))
    const taskFile = JSON.parse(readFileSync(join(generated, "task.json"), "utf8"))
    writeFileSync(
      join(generated, "task.json"),
      JSON.stringify({ ...taskFile, id: "wo-0123456789abcdef" }),
    )
    const out = join(dir, "handoffs")
    const { stdout } = await run(
      process.execPath,
      [tsxBin, cliEntry, "builder-handoff", "--task", "wo-0123456789abcdef", "--out", out],
      { env: { ...rest, FACTORY_STATE_DIR: join(dir, "state") }, cwd: packageRoot },
    )
    const { handoff } = JSON.parse(stdout)
    expect(handoff).toBe(join(out, "wo-0123456789abcdef.handoff.json"))
    expect(BuilderHandoffSchema.parse(JSON.parse(readFileSync(handoff, "utf8"))).taskId).toBe(
      "wo-0123456789abcdef",
    )
  }, 60_000)
})
