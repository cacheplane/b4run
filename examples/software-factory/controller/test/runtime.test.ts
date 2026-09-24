import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DRAFTER_UNCONFIGURED } from "../src/lib/controller/workers.ts"
import { createControllerRuntime } from "../src/lib/runtime.ts"
import { writeTargetFile } from "./builder-target-file.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { noopBuilderManifestWriter } from "./fake-worker-map.ts"
import { repositoryHead } from "./temp-repo.ts"

let dir: string
let fake: FakeWorker
let drafter: FakeWorker | undefined
let second: FakeWorker | undefined
afterEach(async () => {
  await fake?.close()
  await drafter?.close()
  await second?.close()
  drafter = undefined
  second = undefined
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
      FACTORY_BUILDER_TARGET: writeTargetFile(join(dir, "targets"), "cli-flags"),
    })
    const a = await runtime.factory()
    const b = await runtime.factory()
    expect(a).toBe(b)
    await runtime.dispose()
    await expect(runtime.factory()).rejects.toThrow(/disposed/)
  })

  it("fixes FACTORY_MAX_INTAKE_ATTEMPTS and FACTORY_MAX_CANDIDATE_ATTEMPTS on the row at create", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const env = {
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_APP_ROOT: join(dir, "builder"),
      FACTORY_BUILDER_TARGET: writeTargetFile(join(dir, "targets"), "cli-flags"),
    }
    const three = createControllerRuntime({
      ...env,
      FACTORY_MAX_INTAKE_ATTEMPTS: "3",
      FACTORY_MAX_CANDIDATE_ATTEMPTS: "4",
    })
    const { id } = await (await three.factory()).create({ taskId: "cli-flags" })
    expect((await three.factory()).show(id)?.maxIntakeAttempts).toBe(3)
    expect((await three.factory()).show(id)?.maxCandidateAttempts).toBe(4)
    await three.dispose()
    // A restart with the default leaves the existing row's cap as it was created.
    const again = createControllerRuntime(env)
    const factory = await again.factory()
    expect(factory.show(id)?.maxIntakeAttempts).toBe(3)
    expect(factory.show(id)?.maxCandidateAttempts).toBe(4)
    const { id: fresh } = await factory.create({ taskId: "cli-flags", operationKey: "second" })
    expect(factory.show(fresh)?.maxIntakeAttempts).toBe(2)
    expect(factory.show(fresh)?.maxCandidateAttempts).toBe(2)
    await again.dispose()
  })

  it("boots from FACTORY_WORKERS, and refuses the map beside the legacy pair", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    second = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const workers = JSON.stringify({
      // One process per target, each over its own copy of the builder package.
      devkit: { url: second.baseUrl, appRoot: join(dir, "devkit-builder") },
      "cli-flags": { url: fake.baseUrl, appRoot: join(dir, "cli-builder"), route: "/fix#agent" },
    })
    const runtime = createControllerRuntime(
      { FACTORY_STATE_DIR: join(dir, "state"), FACTORY_WORKERS: workers },
      { writeBuilderManifest: noopBuilderManifestWriter },
    )
    expect(Object.keys(runtime.config.workers)).toEqual(["devkit", "cli-flags"])
    const factory = await runtime.factory()
    // Each entry's manifest directory is made at boot.
    expect(statSync(join(dir, "cli-builder", ".factory", "manifests")).isDirectory()).toBe(true)
    // A catalog work order dispatches to its target's entry, on that entry's route: the
    // `cli-flags` task's target is the `cli-flags` target.
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    await fake.waitForRunStart(factory.show(id)?.workerThreadId as string)
    const run = fake.requests.find((r) => r.method === "POST" && r.path.endsWith("/runs/stream"))
    expect(run?.body).toMatchObject({ route: "/fix#agent" })
    expect(factory.show(id)?.workerRoute).toBe("/fix#agent")
    expect(second.requests.some((r) => r.path === "/threads")).toBe(false)
    await runtime.dispose()
    expect(() =>
      createControllerRuntime({
        FACTORY_STATE_DIR: join(dir, "state"),
        FACTORY_WORKERS: workers,
        FACTORY_WORKER_URL: fake.baseUrl,
        FACTORY_BUILDER_APP_ROOT: join(dir, "builder"),
      }),
    ).toThrow("FACTORY_WORKERS is set; unset FACTORY_WORKER_URL and FACTORY_BUILDER_APP_ROOT")
  })

  it("routes the legacy pair only its builder's target: another is refused unspent", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const env = {
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_APP_ROOT: join(dir, "builder"),
    }
    // The one builder boots from the devkit target file, so the controller keys it `devkit`.
    const devkitOnly = createControllerRuntime(
      { ...env, FACTORY_BUILDER_TARGET: writeTargetFile(join(dir, "targets"), "devkit") },
      { writeBuilderManifest: noopBuilderManifestWriter },
    )
    expect(Object.keys(devkitOnly.config.workers)).toEqual(["devkit"])
    const factory = await devkitOnly.factory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    // Before the wildcard went, this created a thread on a builder that refuses the work
    // order at admission, and the row went terminal `failed`.
    expect(await factory.dispatch(id)).toEqual({
      ok: false,
      state: "received",
      message: "no worker for target cli-flags",
    })
    expect(fake.requests.some((r) => r.path === "/threads")).toBe(false)
    expect(factory.events(id).map((e) => e.type)).not.toContain("builder_manifest_written")
    await devkitOnly.dispose()
    // Unspent: with the builder for the right target, the SAME call under the default key
    // dispatches.
    const cliFlags = createControllerRuntime(
      { ...env, FACTORY_BUILDER_TARGET: writeTargetFile(join(dir, "targets"), "cli-flags") },
      { writeBuilderManifest: noopBuilderManifestWriter },
    )
    expect(await (await cliFlags.factory()).dispatch(id)).toMatchObject({
      ok: true,
      state: "dispatched",
    })
    expect(fake.requests.filter((r) => r.path === "/threads")).toHaveLength(1)
    await cliFlags.dispose()
  })

  it("configures intake from the drafter pair, and refuses intake without it", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    drafter = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const repo = repositoryHead()
    const env = {
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_APP_ROOT: join(dir, "builder"),
      FACTORY_BUILDER_TARGET: writeTargetFile(join(dir, "targets"), "cli-flags"),
    }
    const issue = {
      origin: {
        kind: "issue" as const,
        repository: "cacheplane/b4run",
        number: 778,
        bodyDigest: "0".repeat(64),
      },
      pin: repo.pin,
      issue: { title: "t", body: "b" },
    }
    const without = createControllerRuntime(env)
    const unconfigured = await without.factory()
    const { id } = await unconfigured.createFromIssue(issue)
    expect(await unconfigured.intake(id)).toEqual({
      ok: false,
      state: "received",
      message: DRAFTER_UNCONFIGURED,
    })
    await without.dispose()
    // Half a pair is a boot refusal, not an unconfigured intake.
    expect(() =>
      createControllerRuntime({ ...env, FACTORY_DRAFTER_URL: drafter?.baseUrl }),
    ).toThrow("FACTORY_DRAFTER_URL and FACTORY_DRAFTER_APP_ROOT: set both or neither")
    mkdirSync(join(dir, "drafter"), { recursive: true })
    const configured = createControllerRuntime(
      {
        ...env,
        FACTORY_DRAFTER_URL: drafter?.baseUrl,
        FACTORY_DRAFTER_APP_ROOT: join(dir, "drafter"),
      },
      {
        // The pin is no commit of any repository: the capture is stood in for.
        writeDrafterManifest: async ({ dir: target, workOrderId }) => ({
          path: join(target, `${workOrderId}.json`),
          sourceDigest: "c".repeat(64),
        }),
      },
    )
    // The manifest directory is made at boot, under the drafter's app root by default.
    const factory = await configured.factory()
    expect(configured.config.drafter?.manifestDir).toBe(
      join(dir, "drafter", ".factory", "manifests"),
    )
    expect(statSync(configured.config.drafter?.manifestDir as string).isDirectory()).toBe(true)
    expect(await factory.intake(id)).toEqual({
      ok: true,
      state: "intake_running",
      message: "Intake started",
    })
    // The intake thread was created on the DRAFTER, not the builder.
    expect(drafter?.requests.filter((r) => r.path === "/threads")).toHaveLength(1)
    expect(fake.requests.filter((r) => r.path === "/threads")).toHaveLength(0)
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
      FACTORY_BUILDER_TARGET: writeTargetFile(join(dir, "targets"), "cli-flags"),
    }
    const absent = createControllerRuntime({
      ...env,
      FACTORY_DRAFTER_URL: fake.baseUrl,
      FACTORY_DRAFTER_APP_ROOT: join(dir, "no-such-drafter"),
    })
    await expect(absent.factory()).rejects.toThrow(
      `FACTORY_DRAFTER_APP_ROOT is not a directory (${join(dir, "no-such-drafter")})`,
    )
    await absent.dispose()
    const file = join(dir, "drafter-file")
    writeFileSync(file, "")
    const notDirectory = createControllerRuntime({
      ...env,
      FACTORY_DRAFTER_URL: fake.baseUrl,
      FACTORY_DRAFTER_APP_ROOT: file,
    })
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
      FACTORY_BUILDER_TARGET: writeTargetFile(join(dir, "targets"), "cli-flags"),
    })
    await expect(runtime.factory()).rejects.toThrow()
    rmSync(blocker, { force: true })
    await expect(runtime.factory()).resolves.toBeDefined()
    await runtime.dispose()
  })
})
