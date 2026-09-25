import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DRAFTER_UNCONFIGURED } from "../src/lib/controller/workers.ts"
import { createControllerRuntime } from "../src/lib/runtime.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { noopBuilderManifestWriter } from "./fake-worker-map.ts"
import { repositoryHead } from "./temp-repo.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

let dir: string
let fake: FakeWorker
let drafter: FakeWorker | undefined
afterEach(async () => {
  await fake?.close()
  await drafter?.close()
  drafter = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe("controller runtime", () => {
  it("opens one Factory for the process and closes it on dispose", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const runtime = createControllerRuntime({
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_MANIFEST_DIR: join(dir, "builder", "manifests"),
      FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
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
      FACTORY_BUILDER_MANIFEST_DIR: join(dir, "builder", "manifests"),
      FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
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

  it("dispatches to the one builder on its route, and refuses the retired variables", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const env = {
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_MANIFEST_DIR: join(dir, "builder", "manifests"),
      FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
      FACTORY_WORKER_ROUTE: "/fix#agent",
    }
    const runtime = createControllerRuntime(env, {
      writeBuilderManifest: noopBuilderManifestWriter,
    })
    expect(runtime.config.builder).toEqual({
      url: fake.baseUrl,
      route: "/fix#agent",
      manifestDir: join(dir, "builder", "manifests"),
    })
    const factory = await runtime.factory()
    // The builder's manifest directory is made at boot.
    expect(statSync(join(dir, "builder", "manifests")).isDirectory()).toBe(true)
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    await fake.waitForRunStart(factory.show(id)?.workerThreadId as string)
    const run = fake.requests.find((r) => r.method === "POST" && r.path.endsWith("/runs/stream"))
    expect(run?.body).toMatchObject({ route: "/fix#agent" })
    // The runtime's client carries the configured token on every request it made.
    expect(fake.requests.length).toBeGreaterThan(0)
    for (const logged of fake.requests)
      expect(logged.authorization).toBe(`Bearer ${TEST_WORKER_TOKEN}`)
    expect(factory.show(id)?.workerRoute).toBe("/fix#agent")
    await runtime.dispose()
    // An operator still setting a retired variable is told it does nothing now.
    for (const [name, value] of [
      ["FACTORY_WORKERS", JSON.stringify({ devkit: { url: fake.baseUrl, appRoot: dir } })],
      ["FACTORY_BUILDER_TARGET", join(dir, "cli-flags.target.json")],
      ["FACTORY_BUILDER_APP_ROOT", join(dir, "builder")],
      ["FACTORY_DRAFTER_APP_ROOT", join(dir, "drafter")],
    ] as const)
      expect(() => createControllerRuntime({ ...env, [name]: value })).toThrow(`${name} is retired`)
    // The drafter's image is the drafter's: a shared environment still boots, with one line.
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    try {
      const shared = createControllerRuntime({
        ...env,
        FACTORY_DRAFTER_IMAGE: `node:24-slim@sha256:${"a".repeat(64)}`,
      })
      await shared.dispose()
    } finally {
      spy.mockRestore()
    }
    expect(written.filter((line) => line.includes("FACTORY_DRAFTER_IMAGE"))).toEqual([
      expect.stringContaining('"event":"config_ignored"'),
    ])
  })

  it("configures intake from the drafter pair, and refuses intake without it", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    drafter = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const repo = repositoryHead()
    const env = {
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_MANIFEST_DIR: join(dir, "builder", "manifests"),
      FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
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
    // A drafter URL without the manifest directory is a boot refusal, not an unconfigured
    // intake.
    expect(() =>
      createControllerRuntime({ ...env, FACTORY_DRAFTER_URL: drafter?.baseUrl }),
    ).toThrow("FACTORY_DRAFTER_MANIFEST_DIR is required with FACTORY_DRAFTER_URL")
    const configured = createControllerRuntime(
      {
        ...env,
        FACTORY_DRAFTER_URL: drafter?.baseUrl,
        FACTORY_DRAFTER_MANIFEST_DIR: join(dir, "drafter", "manifests"),
      },
      {
        // The pin is no commit of any repository: the capture is stood in for.
        writeDrafterManifest: async ({ dir: target, workOrderId }) => ({
          path: join(target, `${workOrderId}.json`),
          sourceDigest: "c".repeat(64),
        }),
      },
    )
    // The manifest directory is made at boot.
    const factory = await configured.factory()
    expect(configured.config.drafter?.manifestDir).toBe(join(dir, "drafter", "manifests"))
    expect(statSync(configured.config.drafter?.manifestDir as string).isDirectory()).toBe(true)
    expect(await factory.intake(id)).toEqual({
      ok: true,
      state: "intake_running",
      message: "Intake started",
    })
    // The intake thread was created on the DRAFTER, not the builder.
    expect(drafter?.requests.filter((r) => r.path === "/threads")).toHaveLength(1)
    expect(fake.requests.filter((r) => r.path === "/threads")).toHaveLength(0)
    // The real drafter reader asks the DRAFTER's port, with the token and the handed digest's
    // thread; this fake serves no workspace read, so its 404 is a failed run, not a spent
    // attempt, and the row is blocked rather than left running when the runtime is disposed.
    expect((await factory.settleIntake(id, 20_000)).blockedReason).toBe("intake_run_failed")
    const threadId = factory.show(id)?.workerThreadId as string
    const inspects = drafter?.requests.filter((r) => r.path.endsWith("/workspace/inspect"))
    expect(inspects).toEqual([
      expect.objectContaining({
        method: "POST",
        path: `/threads/${threadId}/workspace/inspect`,
        authorization: `Bearer ${TEST_WORKER_TOKEN}`,
        body: expect.objectContaining({ root: "draft" }),
      }),
    ])
    expect(fake.requests.filter((r) => r.path.endsWith("/workspace/inspect"))).toEqual([])
    const unreadable = factory.events(id).find((e) => e.type === "workspace_unreadable")
    expect(unreadable?.payload).toMatchObject({ phase: "intake", status: 404 })
    await configured.dispose()
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
      FACTORY_BUILDER_MANIFEST_DIR: join(dir, "builder", "manifests"),
      FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
    })
    await expect(runtime.factory()).rejects.toThrow()
    rmSync(blocker, { force: true })
    await expect(runtime.factory()).resolves.toBeDefined()
    await runtime.dispose()
  })
})
