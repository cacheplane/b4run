import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createControllerRuntime } from "../src/lib/runtime.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
afterEach(async () => {
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("controller runtime", () => {
  it("opens one Factory for the process and closes it on dispose", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const runtime = createControllerRuntime({
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_APP_ROOT: join(dir, "builder"),
    })
    const a = await runtime.factory()
    const b = await runtime.factory()
    expect(a).toBe(b)
    await runtime.dispose()
    await expect(runtime.factory()).rejects.toThrow(/disposed/)
  })

  it("configures intake from the drafter app root, and refuses intake without it", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const env = {
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_APP_ROOT: join(dir, "builder"),
    }
    const issue = {
      origin: {
        kind: "issue" as const,
        repository: "cacheplane/b4run",
        number: 778,
        bodyDigest: "0".repeat(64),
      },
      pin: "a".repeat(40),
      issue: { title: "t", body: "b" },
    }
    const without = createControllerRuntime(env)
    const unconfigured = await without.factory()
    const { id } = await unconfigured.createFromIssue(issue)
    expect(await unconfigured.intake(id)).toEqual({
      ok: false,
      state: "received",
      message: "intake is not configured: set FACTORY_DRAFTER_APP_ROOT",
    })
    await without.dispose()
    // The legacy task variable configures nothing any more: parsed, but not what intake reads.
    const legacy = createControllerRuntime({ ...env, FACTORY_INTAKE_TASK: "devkit-spawn-deadline" })
    const stillUnconfigured = await legacy.factory()
    expect(await stillUnconfigured.intake(id)).toEqual({
      ok: false,
      state: "received",
      message: "intake is not configured: set FACTORY_DRAFTER_APP_ROOT",
    })
    await legacy.dispose()
    mkdirSync(join(dir, "drafter"), { recursive: true })
    const configured = createControllerRuntime({
      ...env,
      FACTORY_DRAFTER_APP_ROOT: join(dir, "drafter"),
    })
    const factory = await configured.factory()
    expect(await factory.intake(id)).toEqual({
      ok: true,
      state: "intake_running",
      message: "Intake started",
    })
    // The real drafter reader finds no installation under the app root (the drafter app has
    // not booted there): a failed run naming the variable to fix, and the row is blocked
    // rather than left running when the runtime is disposed.
    expect((await factory.settleIntake(id, 20_000)).blockedReason).toBe("intake_run_failed")
    const unreadable = factory.events(id).find((e) => e.type === "workspace_unreadable")
    expect(String(unreadable?.payload.error)).toMatch(
      /FACTORY_DRAFTER_APP_ROOT has no workspace installation/,
    )
    await configured.dispose()
  })

  it("refuses a drafter app root that is not a directory at boot", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const env = {
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_APP_ROOT: join(dir, "builder"),
    }
    const absent = createControllerRuntime({
      ...env,
      FACTORY_DRAFTER_APP_ROOT: join(dir, "no-such-drafter"),
    })
    await expect(absent.factory()).rejects.toThrow(
      `FACTORY_DRAFTER_APP_ROOT is not a directory (${join(dir, "no-such-drafter")})`,
    )
    await absent.dispose()
    const file = join(dir, "drafter-file")
    writeFileSync(file, "")
    const notDirectory = createControllerRuntime({ ...env, FACTORY_DRAFTER_APP_ROOT: file })
    await expect(notDirectory.factory()).rejects.toThrow(
      /FACTORY_DRAFTER_APP_ROOT is not a directory/,
    )
    await notDirectory.dispose()
  })

  it("retries a failed open on the next call", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    // A registry path inside a FILE is unopenable: mkdir fails with ENOTDIR.
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "")
    const runtime = createControllerRuntime({
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(blocker, "state"),
      FACTORY_BUILDER_APP_ROOT: join(dir, "builder"),
    })
    await expect(runtime.factory()).rejects.toThrow()
    rmSync(blocker, { force: true })
    await expect(runtime.factory()).resolves.toBeDefined()
    await runtime.dispose()
  })
})
