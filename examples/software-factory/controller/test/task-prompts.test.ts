import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { taskPrompts } from "../src/lib/prompts.ts"
import type { CatalogOptions } from "../src/lib/targets/catalog.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

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
        ...(prepared ? { image } : {}),
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

describe("taskPrompts", () => {
  it("omits and reports a task whose target is unprepared, rather than refusing to answer at all", () => {
    const { root, pin } = repo()
    const options: CatalogOptions = { ...catalogs(pin), repositoryRoot: root }
    const unavailable: Array<[string, string]> = []
    const prompts = taskPrompts((id, error) => unavailable.push([id, String(error)]), options)
    expect(Object.keys(prompts)).toEqual(["served"])
    expect(prompts.served).toMatch(/Run the tests with `npm test`\./)
    expect(unavailable.map(([id]) => id)).toEqual(["unprepared"])
    expect(unavailable[0]?.[1]).toMatch(/has not been prepared/)
  })

  it("answers with nothing, and reports why, when there is no catalog at all", () => {
    const unavailable: string[] = []
    expect(
      taskPrompts((id) => unavailable.push(id), {
        tasksDir: join(temporary("factory-none-"), "x"),
      }),
    ).toEqual({})
    expect(unavailable).toEqual(["(catalog)"])
  })

  it("serves the shipped catalog without reporting anything unavailable", () => {
    const unavailable: string[] = []
    const prompts = taskPrompts((id) => unavailable.push(id))
    expect(Object.keys(prompts)).toEqual(["cli-flags", "devkit-spawn-deadline"])
    expect(unavailable).toEqual([])
  })
})

describe("the controller over a partly unprepared catalog", () => {
  it("creates a work order for the task it can serve and refuses the one it cannot", async () => {
    const { root, pin } = repo()
    const dir = temporary("factory-prompts-state-")
    worker = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      worker: createHttpWorkerClient(worker.baseUrl),
      workerRoute: "/build#agent",
      exportDir: join(dir, "out"),
      artifactsDir: join(dir, "artifacts"),
      verifier: createFakeVerifier({ verdict: "pass" }),
      workspaceReader: createFakeWorkspaceReader({}),
      captureBaseline: async () => ({ digest: "a".repeat(64), files: new Map() }),
      // The same table the factory builds for itself, over a catalog with one unprepared
      // target: the boot itself is the assertion — it does not throw.
      tasks: taskPrompts(undefined, { ...catalogs(pin), repositoryRoot: root }),
    })
    expect((await factory.create({ taskId: "served" })).id).toMatch(/\S/)
    await expect(factory.create({ taskId: "unprepared" })).rejects.toThrow(
      /Unknown task unprepared/,
    )
  })
})
