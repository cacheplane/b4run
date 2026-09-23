import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { fakeWorkerMap, noopBuilderManifestWriter } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

/**
 * The builder process boots at its target's DEFAULT pin; a task pinned elsewhere is built in
 * that image and verified in its own. `dispatch` refuses, unspent, when the two images'
 * dependencies differ, and journals the comparison either way.
 */
const dirs: string[] = []
let factory: Factory | undefined
let worker: FakeWorker | undefined
afterEach(async () => {
  await factory?.close()
  factory = undefined
  await worker?.close()
  worker = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temporary = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A repository with two commits: the target's default pin and the task's. */
function repo(): { root: string; defaultPin: string; taskPin: string } {
  const root = temporary("factory-builder-env-repo-")
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(root, "a.txt"), "a\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  const defaultPin = git("rev-parse", "HEAD")
  writeFileSync(join(root, "a.txt"), "b\n")
  git("commit", "-q", "-a", "-m", "two")
  return { root, defaultPin, taskPin: git("rev-parse", "HEAD") }
}

const image = (lockfile: string, localId: string) => ({
  localId: `sha256:${localId.repeat(64)}`,
  platform: "linux/arm64",
  baseManifestDigest: `sha256:${"b".repeat(64)}`,
  dockerfileSha256: "c".repeat(64),
  lockfileSha256: lockfile.repeat(64),
  pnpmVersion: "10.33.0",
})

/** Target `t` with images at both pins (lockfiles as given) and task `k` pinned at `taskPin`. */
function catalogs(
  pins: { defaultPin: string; taskPin: string },
  lockfiles: { atDefault: string; atTask: string },
): { targetsDir: string; tasksDir: string; writeTarget: (atTask: string) => void } {
  const targetsDir = temporary("factory-builder-env-targets-")
  mkdirSync(join(targetsDir, "t"))
  const writeTarget = (atTask: string) =>
    writeFileSync(
      join(targetsDir, "t", "target.json"),
      JSON.stringify({
        id: "t",
        pin: pins.defaultPin,
        root: ".",
        capture: { include: ["a.txt"] },
        snapshotIgnore: [],
        images: {
          [pins.defaultPin]: image(lockfiles.atDefault, "1"),
          [pins.taskPin]: image(atTask, "2"),
        },
        imageContext: ["package.json"],
        lockfile: "pnpm-lock.yaml",
        imageAssertResolves: [],
        environmentLinks: [{ path: "node_modules", target: "/opt/targets/t/node_modules" }],
        commands: { cwd: ".", build: [], test: ["npm", "test"], nodeTestExecArgv: [] },
        runnerConfig: ["package.json"],
        resources: {
          memoryMb: 1024,
          cpus: 1,
          commandTimeoutMs: 120_000,
          verifierDeadlineMs: 300_000,
        },
      }),
    )
  writeTarget(lockfiles.atTask)
  const tasksDir = temporary("factory-builder-env-tasks-")
  mkdirSync(join(tasksDir, "k", "checks"), { recursive: true })
  writeFileSync(
    join(tasksDir, "k", "task.json"),
    JSON.stringify({
      id: "k",
      target: "t",
      pin: pins.taskPin,
      allowedSourcePaths: ["src/a.ts"],
      immutablePaths: ["package.json", "test/a.test.ts"],
    }),
  )
  writeFileSync(
    join(tasksDir, "k", "checks.json"),
    JSON.stringify({
      visible: { runner: "vitest", assertions: ["a passes"] },
      independent: { runner: "node-test", file: "checks/k.test.ts", assertions: ["A1"] },
    }),
  )
  writeFileSync(join(tasksDir, "k", "spec.md"), "# k\n\nA1: something holds.\n")
  writeFileSync(join(tasksDir, "k", "checks", "k.test.ts"), "")
  return { targetsDir, tasksDir, writeTarget }
}

async function boot(catalog: { targetsDir: string; tasksDir: string; repositoryRoot: string }) {
  const dir = temporary("factory-builder-env-state-")
  worker = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "tasks"),
    workers: fakeWorkerMap({
      builder: {
        client: createHttpWorkerClient(worker.baseUrl),
        reader: createFakeWorkspaceReader({}),
      },
    }),
    writeBuilderManifest: noopBuilderManifestWriter,
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ verdict: "pass" }),
    captureBaseline: async () => ({ digest: "a".repeat(64), files: new Map() }),
    promptCatalog: catalog,
  })
  return factory
}

const environmentEvents = (f: Factory, id: string) =>
  f.events(id).filter((e) => e.type === "builder_environment_differs")
const threadPosts = () => (worker?.requests ?? []).filter((r) => r.path === "/threads")

describe("dispatch of a task pinned away from its builder's pin", () => {
  it("refuses, unspent, when the dependencies differ, and proceeds under the same key once they agree", async () => {
    const { root, defaultPin, taskPin } = repo()
    const { targetsDir, tasksDir, writeTarget } = catalogs(
      { defaultPin, taskPin },
      { atDefault: "d", atTask: "e" },
    )
    const f = await boot({ targetsDir, tasksDir, repositoryRoot: root })
    const { id } = await f.create({ taskId: "k" })
    expect(await f.dispatch(id)).toEqual({
      ok: false,
      state: "received",
      message: `builder for t runs at ${defaultPin}, whose dependencies differ from ${taskPin}: prepare the target at the work order's pin and restart its builder there, or wait for per-pin builders`,
    })
    expect(environmentEvents(f, id).map((e) => e.payload)).toEqual([
      { builderPin: defaultPin, taskPin, lockfileDiffers: true },
    ])
    expect(threadPosts()).toHaveLength(0)
    expect(f.show(id)?.state).toBe("received")
    // The operator re-prepares the task's pin against the same lockfile: the next dispatch,
    // under the same default key, is not a replay of the refusal.
    writeTarget("d")
    expect(await f.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    expect(environmentEvents(f, id).map((e) => e.payload)).toEqual([
      { builderPin: defaultPin, taskPin, lockfileDiffers: true },
      { builderPin: defaultPin, taskPin, lockfileDiffers: false },
    ])
  })

  it("proceeds and journals the difference when the two images share a lockfile", async () => {
    const { root, defaultPin, taskPin } = repo()
    const { targetsDir, tasksDir } = catalogs(
      { defaultPin, taskPin },
      { atDefault: "d", atTask: "d" },
    )
    const f = await boot({ targetsDir, tasksDir, repositoryRoot: root })
    const { id } = await f.create({ taskId: "k" })
    expect(await f.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    expect(environmentEvents(f, id).map((e) => e.payload)).toEqual([
      { builderPin: defaultPin, taskPin, lockfileDiffers: false },
    ])
  })
})
