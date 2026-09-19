import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentHarness, script } from "@b4run/testing"
import type { SandboxHandle } from "@b4run/workspace"
import { afterEach, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/controller/factory.ts"
import { loadFixture } from "../src/fixtures/catalog.ts"
import {
  builderSandboxProvider,
  sandboxPolicy,
  workspaceInspectionOptions,
} from "../src/fixtures/workspace.ts"
import { TASK_PROMPTS } from "../src/prompts.ts"
import { createArtifactStore } from "../src/storage/artifacts.ts"
import { captureFixtureBaseline } from "../src/verification/baseline.ts"
import { createDockerVerifier } from "../src/verification/docker-verifier.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { createThreadWorkspaceReader } from "../src/worker/workspace-reader.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { isolatedApp } from "./isolated-app.ts"
import { applyReference } from "./reference-repair.ts"

/**
 * The join: bytes that exist only inside a real thread's workspace volume, read out by the
 * controller's own reader, assembled against the controller's own captured baseline,
 * verified in the controller's own container, frozen into a bundle and exported.
 *
 * What is real here: the workspace volume, the reader (a separate read-only container over
 * that volume), the captured baseline, the assembly, the verifier, the bundle and the
 * export. What is not: the Agent Protocol worker is the fake HTTP one, pointed at the thread
 * whose workspace the controller then reads, and the bytes in that workspace are placed
 * through the sandbox handle rather than by a builder turn — see the second test for why
 * the builder's own workspace cannot be read yet.
 */

const fixture = loadFixture("cli-flags")
const source = fixture.manifest.allowedSourcePaths[0] as string

let factory: Factory | undefined
let worker: FakeWorker | undefined
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await factory?.close()
  factory = undefined
  await worker?.close()
  worker = undefined
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Build a thread workspace in PROVIDER storage that matches what the builder's workspace
 * definition produces: the captured baseline's files, a `.git` directory standing in for the
 * git baseline, and the `node_modules` environment link. Both structural inspection options
 * are therefore exercised against real Docker rather than merely passed.
 */
async function materializeThreadWorkspace(
  handle: SandboxHandle,
  signal: AbortSignal,
): Promise<void> {
  const ctx = { workspaceRoot: handle.workspaceRoot, signal }
  const baseline = await captureFixtureBaseline("cli-flags", signal)
  for (const [path, content] of baseline.files)
    await handle.filesystem.writeFile(`${handle.workspaceRoot}/${path}`, content, ctx)
  const link = workspaceInspectionOptions("cli-flags").expectedRootSymlinks.node_modules as string
  const prepared = await handle.exec.runCommand(
    {
      command: `mkdir -p ${handle.workspaceRoot}/.git && printf 'ref: refs/heads/main\\n' > ${handle.workspaceRoot}/.git/HEAD && ln -sfn ${link} ${handle.workspaceRoot}/node_modules`,
    },
    ctx,
  )
  expect({ exitCode: prepared.exitCode, stderr: prepared.stderr }).toEqual({
    exitCode: 0,
    stderr: "",
  })
}

it("reads a real thread workspace and turns those bytes into a verdict, a bundle and an export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-e2e-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const exportDir = join(dir, "out")
  await mkdir(exportDir, { recursive: true })
  // The historical reference repair: bytes known to be correct, so a failing verdict over
  // them is this lane's fault and not the candidate's.
  const repaired = await applyReference()

  const threadId = `e2e-${randomUUID()}`
  const builder = builderSandboxProvider()
  cleanups.push(() => builder.destroy(threadId))
  const handle = await builder.acquire({
    threadId,
    policy: sandboxPolicy,
    signal: AbortSignal.timeout(180_000),
  })
  await materializeThreadWorkspace(handle, AbortSignal.timeout(180_000))
  // The one change the work order is about, written inside the container and nowhere else.
  await handle.filesystem.writeFile(`${handle.workspaceRoot}/${source}`, repaired, {
    workspaceRoot: handle.workspaceRoot,
    signal: AbortSignal.timeout(60_000),
  })
  // Compute released, workspace volume KEPT: the state the controller reads in, and one of
  // the states `openWorkspaceReader` is specified for.
  await builder.release(threadId)

  // A DIFFERENT provider instance, as the controller is a different process in production,
  // addressing the same storage by scope and thread id.
  const reader = createThreadWorkspaceReader(builderSandboxProvider(), workspaceInspectionOptions)
  const observed = await reader.read(
    { threadId, taskId: "cli-flags" },
    AbortSignal.timeout(120_000),
  )
  expect(observed.get(source)).toBe(repaired)
  expect(observed.get("TASK.md")).toBe(await readFile(join(fixture.directory, "task.md"), "utf8"))
  // Both structural inspection options are load-bearing against real Docker: the git
  // directory is excluded rather than reported as added paths, and the `node_modules`
  // symlink is validated against its exact target rather than walked into. Without either,
  // the read above would have thrown or produced a scope violation below.
  expect([...observed.keys()].filter((path) => path.startsWith(".git/"))).toEqual([])
  // The git directory is EXCLUDED, not absent: `.gitignore` is part of the captured
  // baseline and must survive, so the exclusion has to be a root-directory rule.
  expect(observed.has(".gitignore")).toBe(true)
  expect(observed.has("node_modules")).toBe(false)

  worker = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", threadId })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(worker.baseUrl),
    workerRoute: "/build#agent",
    exportDir,
    artifactsDir: join(dir, "artifacts"),
    verifier: createDockerVerifier(createArtifactStore(join(dir, "artifacts"))),
    workspaceReader: createThreadWorkspaceReader(
      builderSandboxProvider(),
      workspaceInspectionOptions,
    ),
    captureBaseline: captureFixtureBaseline,
  })
  const { id } = await factory.create({ taskId: "cli-flags" })
  await factory.dispatch(id)
  const reviewed = await factory.waitFor(
    id,
    (row) => row.state === "awaiting_approval" || row.state === "blocked" || row.state === "failed",
    600_000,
  )
  expect({ state: reviewed.state, blocked: reviewed.blockedReason }).toEqual({
    state: "awaiting_approval",
    blocked: null,
  })

  const evidence = factory.evidence(id)
  // The candidate is the diff between the controller's captured baseline and the bytes it
  // read for itself: one changed path, the one the builder is allowed to write.
  expect(evidence.candidate?.changedPaths).toEqual([source])
  expect(evidence.candidate?.baselineDigest).toBe(
    (await captureFixtureBaseline("cli-flags", AbortSignal.timeout(60_000))).digest,
  )
  expect(evidence.receipt?.verdict).toBe("pass")
  expect(evidence.receipt?.candidateDigest).toBe(evidence.candidate?.digest)
  // Earned in the controller's own container, over its own copy of the independent checks —
  // which were never in the read workspace to begin with.
  expect(evidence.receipt?.checks.map((check) => check.id)).toEqual(["visible", "independent"])
  expect(evidence.receipt?.verifierIdentity).toMatch(/^docker:/)
  expect(evidence.bundle?.digest).toBe(reviewed.bundleDigest)
  expect(evidence.bundle?.candidateDigest).toBe(evidence.candidate?.digest)

  const approved = await factory.approve(id, {
    revision: reviewed.revision,
    bundleDigest: reviewed.bundleDigest as string,
  })
  expect({ ok: approved.ok, state: approved.state }).toEqual({ ok: true, state: "exported" })
  // Only the approved bytes leave, under the bundle's own name.
  expect(await readdir(exportDir)).toEqual([`${reviewed.bundleDigest}.json`])
  const exported = JSON.parse(
    await readFile(join(exportDir, `${reviewed.bundleDigest}.json`), "utf8"),
  ) as { changes: Record<string, string> }
  expect(exported.changes).toEqual({ [source]: repaired })
}, 900_000)

/**
 * The half of the join that is still open, pinned rather than described.
 *
 * The builder is configured with a workspace DEFINITION, so its threads are managed
 * workspaces: `SandboxManager` routes them to `ManagedWorkspaceProvider`, whose bytes live in
 * a `b4-ws-volume-<intent hash>` volume and never in the provider storage that
 * `openWorkspaceReader` addresses by thread id. So the read below fails on a workspace that
 * demonstrably exists — the builder's own tools read and wrote it in this very test.
 *
 * The thread-workspace-read spec put a managed-workspace-aware variant out of scope on the
 * grounds that addressing by thread id against provider storage "is what the first consumer
 * has". This test is the counter-example: the first consumer is this controller, and it does
 * not. Delete it, and read the builder's real workspace in the test above, once the surface
 * covers managed workspaces.
 */
it("cannot yet read the builder's own workspace, because it is a managed workspace", async () => {
  const appRoot = await isolatedApp()
  cleanups.push(() => rm(appRoot, { recursive: true, force: true }))
  const repaired = await applyReference()
  const harness = await createAgentHarness({ appRoot, route: "/build#agent" })
  let threadId: string
  try {
    const input = TASK_PROMPTS["cli-flags"] as string
    const run = await harness.run({
      input,
      fixtures: script()
        .user(input)
        .callsTool("readFile", { path: "TASK.md" })
        .callsTool("writeFile", { path: source, content: repaired })
        .callsTool("runBash", { command: "npm test" })
        .replies("Repair complete.")
        .build(),
    })
    // The bytes really are in the builder's workspace: its own tools put them there and the
    // fixture's test command ran over them in the container.
    expect(run.toolResults.map((result) => result.isError)).toEqual([false, false, false])
    expect(String(run.toolResults[2]?.content)).toContain("b4-fixture-cli-flags")
    threadId = run.threadId

    // Read while the thread is idle between turns — the exact state the capability is
    // specified for, and with the workspace indisputably still alive. Not "the workspace is
    // empty" and not a hang: the capability looks for storage in a place this thread's bytes
    // have never been, and says so.
    const reader = createThreadWorkspaceReader(builderSandboxProvider(), workspaceInspectionOptions)
    await expect(
      reader.read({ threadId, taskId: "cli-flags" }, AbortSignal.timeout(120_000)),
    ).rejects.toThrow(/no workspace storage for thread/)
  } finally {
    await harness.close({ destroyWorkspaces: true })
  }
}, 600_000)
