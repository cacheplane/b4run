import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentHarness, script } from "@b4run/testing"
import { afterEach, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/controller/factory.ts"
import { loadFixture } from "../src/fixtures/catalog.ts"
import { builderSandboxProvider, workspaceInspectionOptions } from "../src/fixtures/workspace.ts"
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
 * The join: bytes the BUILDER'S OWN TOOLS wrote into its managed workspace during a real
 * turn, read out by the controller's own reader, assembled against the controller's own
 * captured baseline, verified in the controller's own container, frozen into a bundle and
 * exported.
 *
 * What is real here: the builder route, its tools, its permission config, its managed
 * workspace (a `b4-ws-volume-*` published under the builder's installation), the reader (a
 * separate read-only container over that volume, resolved through the builder's installation
 * store), the captured baseline, the assembly, the verifier, the bundle and the export. What
 * is not: the model is scripted (the harness's aimock), and the Agent Protocol worker the
 * controller dispatches to is the fake HTTP one, pointed at the thread the real builder just
 * ran — the controller then reads that thread's workspace for itself.
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

it("reads the builder's own workspace and turns those bytes into a verdict, a bundle and an export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-e2e-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const exportDir = join(dir, "out")
  await mkdir(exportDir, { recursive: true })
  // The historical reference repair: bytes known to be correct, so a failing verdict over
  // them is this lane's fault and not the candidate's.
  const repaired = await applyReference()

  // The builder: this package's own app, in an isolated root so its installation store and
  // checkpoints are this test's and nobody else's. The harness OWNS that installation for as
  // long as it is open — exactly as a running `b4` server does — so the controller below has
  // to read it without becoming a second owner.
  const appRoot = await isolatedApp()
  cleanups.push(() => rm(appRoot, { recursive: true, force: true }))
  const harness = await createAgentHarness({ appRoot, route: "/build#agent" })
  cleanups.push(() => harness.close({ destroyWorkspaces: true }))
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
  const threadId = run.threadId

  // Read while the thread is IDLE BETWEEN TURNS, with its session container still alive:
  // one of the two states the read surface is specified for, and the one `docker exec` into
  // the builder could never serve safely. A DIFFERENT provider instance, as the controller is
  // a different process in production, addressing the same storage by scope, image and the
  // builder's installation store.
  const reader = createThreadWorkspaceReader(
    { provider: builderSandboxProvider(), appRoot },
    workspaceInspectionOptions,
  )
  const observed = await reader.read(
    { threadId, taskId: "cli-flags" },
    AbortSignal.timeout(120_000),
  )
  expect(observed.get(source)).toBe(repaired)
  // Bridge until src/fixtures is retired: the spec now lives under tasks/<id>/.
  expect(observed.get("TASK.md")).toBe(
    await readFile(join(fixture.tasksDirectory, "spec.md"), "utf8"),
  )
  // Both structural inspection options are load-bearing against real Docker: the git
  // directory is excluded rather than reported as added paths, and the `node_modules`
  // symlink is validated against its exact target rather than walked into. Without either,
  // the read above would have thrown or produced a scope violation below.
  expect([...observed.keys()].filter((path) => path.startsWith(".git/"))).toEqual([])
  // The git directory is EXCLUDED, not absent: `.gitignore` is part of the captured
  // baseline and must survive, so the exclusion has to be a root-directory rule.
  expect(observed.has(".gitignore")).toBe(true)
  expect(observed.has("node_modules")).toBe(false)
  // Reading disturbed nothing: the builder's next turn runs its tools in the same session
  // and workspace. (Which script the harness replays for that turn is not asserted — its
  // fixtures match on the conversation, and the first turn's prompt is still in it.)
  const again = await harness.run({
    input: "Confirm the file.",
    fixtures: script()
      .user("Confirm the file.")
      .callsTool("readFile", { path: source })
      .replies("Confirmed.")
      .build(),
  })
  expect(again.threadId).toBe(threadId)
  expect(again.toolResults.length).toBeGreaterThan(0)
  expect(again.toolResults.map((result) => result.isError)).not.toContain(true)

  worker = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", threadId })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(worker.baseUrl),
    workerRoute: "/build#agent",
    exportDir,
    artifactsDir: join(dir, "artifacts"),
    verifier: createDockerVerifier(createArtifactStore(join(dir, "artifacts"))),
    workspaceReader: createThreadWorkspaceReader(
      { provider: builderSandboxProvider(), appRoot },
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
