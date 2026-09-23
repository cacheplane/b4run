import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

  it("refuses an intake task the catalog cannot load at boot, and accepts one it can", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-runtime-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const env = {
      FACTORY_WORKER_URL: fake.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_BUILDER_APP_ROOT: join(dir, "builder"),
    }
    const unknown = createControllerRuntime({ ...env, FACTORY_INTAKE_TASK: "no-such-task" })
    await expect(unknown.factory()).rejects.toThrow(
      /FACTORY_INTAKE_TASK names a task the catalog cannot load \(no-such-task\)/,
    )
    await unknown.dispose()
    const known = createControllerRuntime({ ...env, FACTORY_INTAKE_TASK: "devkit-spawn-deadline" })
    await expect(known.factory()).resolves.toBeDefined()
    await known.dispose()
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
