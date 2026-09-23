import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { imageTag } from "../src/lib/targets/catalog.ts"
import { builderTargetForTask } from "../src/lib/targets/workspace.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { fakeWorkerMap, noopBuilderManifestWriter } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

/**
 * A builder process runs at ONE pin, its target file's (the worker entry's `pin`; the target's
 * default when the entry names none). A task at another pin is built in that image and
 * verified in its own: `dispatch` journals the comparison and refuses, unspent, when the two
 * environments differ (lockfile, base image or Dockerfile).
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

interface ImageParts {
  readonly lockfile?: string
  readonly base?: string
  readonly dockerfile?: string
}
const image = (localId: string, parts: ImageParts = {}) => ({
  localId: `sha256:${localId.repeat(64)}`,
  platform: "linux/arm64",
  baseManifestDigest: `sha256:${(parts.base ?? "b").repeat(64)}`,
  dockerfileSha256: (parts.dockerfile ?? "c").repeat(64),
  lockfileSha256: (parts.lockfile ?? "d").repeat(64),
  pnpmVersion: "10.33.0",
})

/**
 * Target `t` (default pin `defaultPin`) with images at both pins, the task pin's built from
 * `atTask`, and two tasks: `k` pinned at `taskPin` (a generated task's shape) and `shipped`
 * with no pin (a catalog task, which runs at the default pin).
 */
function catalogs(
  pins: { defaultPin: string; taskPin: string },
  atTask: ImageParts,
): { targetsDir: string; tasksDir: string; writeTarget: (atTask: ImageParts) => void } {
  const targetsDir = temporary("factory-builder-env-targets-")
  mkdirSync(join(targetsDir, "t"))
  const writeTarget = (parts: ImageParts) =>
    writeFileSync(
      join(targetsDir, "t", "target.json"),
      JSON.stringify({
        id: "t",
        pin: pins.defaultPin,
        root: ".",
        capture: { include: ["a.txt"] },
        snapshotIgnore: [],
        images: { [pins.defaultPin]: image("1"), [pins.taskPin]: image("2", parts) },
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
  writeTarget(atTask)
  const tasksDir = temporary("factory-builder-env-tasks-")
  for (const [id, pin] of [
    ["k", pins.taskPin],
    ["shipped", undefined],
  ] as const) {
    mkdirSync(join(tasksDir, id, "checks"), { recursive: true })
    writeFileSync(
      join(tasksDir, id, "task.json"),
      JSON.stringify({
        id,
        target: "t",
        ...(pin !== undefined ? { pin } : {}),
        allowedSourcePaths: ["src/a.ts"],
        immutablePaths: ["package.json", "test/a.test.ts"],
      }),
    )
    writeFileSync(
      join(tasksDir, id, "checks.json"),
      JSON.stringify({
        visible: { runner: "vitest", assertions: ["a passes"] },
        independent: { runner: "node-test", file: `checks/${id}.test.ts`, assertions: ["A1"] },
      }),
    )
    writeFileSync(join(tasksDir, id, "spec.md"), "# k\n\nA1: something holds.\n")
    writeFileSync(join(tasksDir, id, "checks", `${id}.test.ts`), "")
  }
  return { targetsDir, tasksDir, writeTarget }
}

async function boot(
  catalog: { targetsDir: string; tasksDir: string; repositoryRoot: string },
  workerPin?: string,
) {
  const dir = temporary("factory-builder-env-state-")
  worker = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "tasks"),
    workers: fakeWorkerMap({
      builder: {
        client: createHttpWorkerClient(worker.baseUrl),
        reader: createFakeWorkspaceReader({}),
        ...(workerPin !== undefined ? { pin: workerPin } : {}),
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

const remedy = (target: string, builderPin: string, taskPin: string, what: string) =>
  `builder for ${target} runs at ${builderPin}, whose environment (${what}) differs from ${taskPin}: prepare ${target} at ${taskPin} (\`pnpm --filter @b4-example/software-factory-controller target:prepare ${target} --pin ${taskPin}\`), then restart its builder from \`factory builder-target --target ${target} --pin ${taskPin}\` and set that pin on its worker entry; or cancel`

describe("dispatch against the builder's pin", () => {
  it("refuses, unspent, when the lockfile differs, and proceeds under the same key once the environments agree", async () => {
    const { root, defaultPin, taskPin } = repo()
    const { targetsDir, tasksDir, writeTarget } = catalogs(
      { defaultPin, taskPin },
      { lockfile: "e" },
    )
    const f = await boot({ targetsDir, tasksDir, repositoryRoot: root })
    const { id } = await f.create({ taskId: "k" })
    expect(await f.dispatch(id)).toEqual({
      ok: false,
      state: "received",
      message: remedy("t", defaultPin, taskPin, "lockfile"),
    })
    expect(environmentEvents(f, id).map((e) => e.payload)).toEqual([
      {
        builderPin: defaultPin,
        taskPin,
        lockfileDiffers: true,
        baseDiffers: false,
        dockerfileDiffers: false,
      },
    ])
    expect(threadPosts()).toHaveLength(0)
    expect(f.show(id)?.state).toBe("received")
    // The task pin's image is re-prepared to agree: the next dispatch, under the same
    // default key, is not a replay of the refusal.
    writeTarget({})
    expect(await f.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    expect(environmentEvents(f, id).at(-1)?.payload).toEqual({
      builderPin: defaultPin,
      taskPin,
      lockfileDiffers: false,
      baseDiffers: false,
      dockerfileDiffers: false,
    })
  })

  it("refuses a differing base image or Dockerfile, naming each", async () => {
    const { root, defaultPin, taskPin } = repo()
    const { targetsDir, tasksDir } = catalogs(
      { defaultPin, taskPin },
      { base: "9", dockerfile: "8" },
    )
    const f = await boot({ targetsDir, tasksDir, repositoryRoot: root })
    const { id } = await f.create({ taskId: "k" })
    expect(await f.dispatch(id)).toEqual({
      ok: false,
      state: "received",
      message: remedy("t", defaultPin, taskPin, "base image, Dockerfile"),
    })
    expect(environmentEvents(f, id).at(-1)?.payload).toMatchObject({
      lockfileDiffers: false,
      baseDiffers: true,
      dockerfileDiffers: true,
    })
  })

  it("proceeds and journals the difference when the two images' environments agree", async () => {
    const { root, defaultPin, taskPin } = repo()
    const { targetsDir, tasksDir } = catalogs({ defaultPin, taskPin }, {})
    const f = await boot({ targetsDir, tasksDir, repositoryRoot: root })
    const { id } = await f.create({ taskId: "k" })
    expect(await f.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    expect(environmentEvents(f, id).map((e) => e.payload)).toEqual([
      {
        builderPin: defaultPin,
        taskPin,
        lockfileDiffers: false,
        baseDiffers: false,
        dockerfileDiffers: false,
      },
    ])
  })

  it("needs nothing when the builder runs at the task's pin", async () => {
    const { root, defaultPin, taskPin } = repo()
    const { targetsDir, tasksDir } = catalogs({ defaultPin, taskPin }, { lockfile: "e" })
    // The operator restarted the builder at the task's pin and set it on the worker entry.
    const f = await boot({ targetsDir, tasksDir, repositoryRoot: root }, taskPin)
    const { id } = await f.create({ taskId: "k" })
    expect(await f.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    expect(environmentEvents(f, id)).toEqual([])
  })

  it("checks a catalog task (no pin) against a builder at a non-default pin the same way", async () => {
    const { root, defaultPin, taskPin } = repo()
    const { targetsDir, tasksDir } = catalogs({ defaultPin, taskPin }, { lockfile: "e" })
    const f = await boot({ targetsDir, tasksDir, repositoryRoot: root }, taskPin)
    const { id } = await f.create({ taskId: "shipped" })
    expect(await f.dispatch(id)).toEqual({
      ok: false,
      state: "received",
      message: remedy("t", taskPin, defaultPin, "lockfile"),
    })
    expect(environmentEvents(f, id).at(-1)?.payload).toMatchObject({
      builderPin: taskPin,
      taskPin: defaultPin,
      lockfileDiffers: true,
    })
  })
})

describe("the builder's target, as its reader addresses it", () => {
  it("is the target at the worker's pin, not the task's, and at the default pin when the worker names none", () => {
    const { root, defaultPin, taskPin } = repo()
    const { targetsDir, tasksDir } = catalogs({ defaultPin, taskPin }, { lockfile: "e" })
    const catalog = { targetsDir, tasksDir, repositoryRoot: root }
    // Task `k` runs at taskPin; a builder at defaultPin is addressed at defaultPin's image.
    const atDefault = builderTargetForTask("k", undefined, catalog)
    expect(atDefault.pin).toBe(defaultPin)
    expect(imageTag(atDefault)).toContain(`:${defaultPin.slice(0, 12)}-`)
    expect(atDefault.image.localId).toBe(`sha256:${"1".repeat(64)}`)
    const atWorker = builderTargetForTask("shipped", taskPin, catalog)
    expect(atWorker.pin).toBe(taskPin)
    expect(atWorker.image.localId).toBe(`sha256:${"2".repeat(64)}`)
  })
})
