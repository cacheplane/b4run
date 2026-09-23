import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { promptFor } from "../src/lib/prompts.ts"
import {
  type CatalogOptions,
  configureCatalog,
  resetCatalogForTests,
} from "../src/lib/targets/catalog.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { fakeWorkerMap, noopBuilderManifestWriter } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

const dirs: string[] = []
let factory: Factory | undefined
let worker: FakeWorker | undefined
afterEach(async () => {
  resetCatalogForTests()
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

/** A throwaway repository with one commit, so both targets can pin something real. */
function repo(): { root: string; pin: string } {
  const root = temporary("factory-prompts-repo-")
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(root, "a.txt"), "a\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  return { root, pin: git("rev-parse", "HEAD") }
}

const image = {
  localId: `sha256:${"a".repeat(64)}`,
  platform: "linux/arm64",
  baseManifestDigest: `sha256:${"b".repeat(64)}`,
  dockerfileSha256: "c".repeat(64),
  lockfileSha256: "d".repeat(64),
  pnpmVersion: "10.33.0",
}

/** Two targets against one pin: `ready` is prepared, `raw` has no image yet. */
function catalogs(pin: string): { targetsDir: string; tasksDir: string } {
  const targetsDir = temporary("factory-prompts-targets-")
  for (const [id, prepared] of [
    ["ready", true],
    ["raw", false],
  ] as const) {
    mkdirSync(join(targetsDir, id))
    writeFileSync(
      join(targetsDir, id, "target.json"),
      JSON.stringify({
        id,
        pin,
        root: ".",
        capture: { include: ["a.txt"] },
        snapshotIgnore: [],
        ...(prepared ? { images: { [pin]: image } } : {}),
        imageContext: ["package.json"],
        lockfile: "pnpm-lock.yaml",
        imageAssertResolves: [],
        environmentLinks: [{ path: "node_modules", target: `/opt/targets/${id}/node_modules` }],
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
  }
  const tasksDir = temporary("factory-prompts-tasks-")
  for (const [id, target] of [
    ["served", "ready"],
    ["unprepared", "raw"],
  ] as const) {
    mkdirSync(join(tasksDir, id, "checks"), { recursive: true })
    writeFileSync(
      join(tasksDir, id, "task.json"),
      JSON.stringify({
        id,
        target,
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
    writeFileSync(join(tasksDir, id, "reference.patch"), "--- a/src/a.ts\n+++ b/src/a.ts\n")
    writeFileSync(join(tasksDir, id, "checks", `${id}.test.ts`), "")
  }
  return { targetsDir, tasksDir }
}

describe("promptFor", () => {
  it("derives the prompt for a task the catalog can serve", () => {
    const { root, pin } = repo()
    const options: CatalogOptions = { ...catalogs(pin), repositoryRoot: root }
    expect(promptFor("served", options)).toMatch(/Run the tests with `npm test`\./)
  })

  it("throws for a task whose target is unprepared, naming why", () => {
    const { root, pin } = repo()
    const options: CatalogOptions = { ...catalogs(pin), repositoryRoot: root }
    expect(() => promptFor("unprepared", options)).toThrow(/has not been prepared/)
  })

  it("throws when there is no catalog at all", () => {
    expect(() => promptFor("served", { tasksDir: join(temporary("factory-none-"), "x") })).toThrow(
      /Unknown task: served/,
    )
  })

  it("serves every shipped task", () => {
    for (const id of ["cli-flags", "devkit-spawn-deadline"])
      expect(promptFor(id)).toMatch(/TASK\.md/)
  })
})

describe("the controller over a partly unprepared catalog", () => {
  it("boots, creates a work order for the task it can serve and refuses the one it cannot", async () => {
    const { root, pin } = repo()
    const { tasksDir, targetsDir } = catalogs(pin)
    const dir = temporary("factory-prompts-state-")
    worker = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const unavailable: Array<[string, string]> = []
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      generatedTasksDir: join(dir, "tasks"),
      captureRoot: dir,
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
      promptCatalog: { tasksDir, targetsDir, repositoryRoot: root },
      log: (event, payload) => {
        if (event === "task_unavailable")
          unavailable.push([String(payload.id), String(payload.error)])
      },
    })
    // Nothing is loaded at boot: the unprepared sibling is only reported when it is named.
    expect(unavailable).toEqual([])
    expect((await factory.create({ taskId: "served" })).id).toMatch(/\S/)
    await expect(factory.create({ taskId: "unprepared" })).rejects.toThrow(
      /Unknown task unprepared/,
    )
    expect(unavailable).toEqual([["unprepared", expect.stringMatching(/has not been prepared/)]])
  })

  it("refuses, rather than throws, a dispatch whose task stopped loading after create", async () => {
    const { root, pin } = repo()
    const { tasksDir, targetsDir } = catalogs(pin)
    const dir = temporary("factory-prompts-state-")
    worker = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      generatedTasksDir: join(dir, "tasks"),
      captureRoot: dir,
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
      promptCatalog: { tasksDir, targetsDir, repositoryRoot: root },
    })
    const { id } = await factory.create({ taskId: "served" })
    // The target loses its image between create and dispatch: an upgrade, or a re-prepare.
    const manifestPath = join(targetsDir, "ready", "target.json")
    const prepared = readFileSync(manifestPath, "utf8")
    const { images: _images, ...unprepared } = JSON.parse(prepared)
    writeFileSync(manifestPath, JSON.stringify(unprepared))
    expect(await factory.dispatch(id)).toMatchObject({
      ok: false,
      state: "received",
      message: expect.stringMatching(/^Unknown task served: .*has not been prepared/),
    })
    expect(factory.show(id)?.state).toBe("received")
    // Refused before the key is spent: the lookup is where a target's pin is fetched, and a
    // refusal that is not a function of the row's revision must not be replayed to the
    // dispatch after the target is prepared again, under the same default key.
    writeFileSync(manifestPath, prepared)
    expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
  })

  it("resolves generated tasks through the configured search path when no catalog is given", () => {
    const { pin } = repo()
    const { tasksDir } = catalogs(pin)
    configureCatalog({ generatedTasksDir: tasksDir })
    // The shipped catalog has no `served`; the generated directory does, and its target is
    // looked up in the SHIPPED targets directory, where `ready` does not exist.
    expect(() => promptFor("served")).toThrow(/Unknown target: ready/)
  })
})
