import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentHarness, script } from "@b4run/testing"
import { afterEach, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/controller/factory.ts"
import { taskPrompt } from "../src/prompts.ts"
import { createArtifactStore } from "../src/storage/artifacts.ts"
import { loadTask } from "../src/targets/catalog.ts"
import { builderSandboxProvider, targetInspectionOptions } from "../src/targets/workspace.ts"
import { captureTargetBaseline } from "../src/verification/baseline.ts"
import { createDockerVerifier } from "../src/verification/docker-verifier.ts"
import { loadPolicy } from "../src/verification/policy.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { createThreadWorkspaceReader } from "../src/worker/workspace-reader.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { isolatedApp } from "./isolated-app.ts"
import { applyReference } from "./reference-repair.ts"

/**
 * Layer 3 for the monorepo target: the same join the `cli-flags` lane proves, over a real
 * package pinned out of this repository. The builder's own tools write the reference repair
 * into its managed workspace; the controller reads those bytes through the byte channel,
 * assembles them against ITS OWN archive of the pin, verifies them in the prepared image,
 * freezes a bundle, approves and exports exactly those bytes.
 *
 * The builder's script does not run the tests. This lane proves the JOIN, not the builder's
 * judgement, and the checks themselves are graded by the layer 2 lane
 * (`target-devkit.integration.test.ts`); paying for a build and a test suite inside the
 * builder's container as well would buy nothing this lane asserts.
 */

const TASK = "devkit-spawn-deadline"
const task = loadTask(TASK)
const source = task.manifest.allowedSourcePaths[0] as string
// Verification is active time and this lane verifies twice (once for the receipt, again at
// approve), so every budget below is derived from the target's own deadline.
const budget = task.target.resources.verifierDeadlineMs

let factory: Factory | undefined
let worker: FakeWorker | undefined
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await factory?.close()
  factory = undefined
  await worker?.close()
  worker = undefined
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  delete process.env.FACTORY_TASK_ID
})

it(
  "carries a scripted devkit repair from the builder's workspace to an export",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-devkit-e2e-"))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const exportDir = join(dir, "out")
    await mkdir(exportDir, { recursive: true })
    // The historical reference repair: bytes known to be correct, so a failing verdict over
    // them is this lane's fault and not the candidate's.
    const repaired = await applyReference(TASK)

    // The copied `b4.config.ts` reads FACTORY_TASK_ID at load, and the harness loads it when
    // it starts: the variable has to be set before the copy is even taken, or the builder
    // would come up sandboxed for the default task and archive the wrong subtree.
    process.env.FACTORY_TASK_ID = TASK
    const appRoot = await isolatedApp()
    cleanups.push(() => rm(appRoot, { recursive: true, force: true }))
    const harness = await createAgentHarness({ appRoot, route: "/build#agent" })
    cleanups.push(() => harness.close({ destroyWorkspaces: true }))
    const input = taskPrompt(task)
    const run = await harness.run({
      input,
      fixtures: script()
        .user(input)
        .callsTool("readFile", { path: "TASK.md" })
        .callsTool("readFile", { path: source })
        .callsTool("writeFile", { path: source, content: repaired })
        .replies("Repair complete.")
        .build(),
    })
    // Every tool call the builder made was admitted: the spec is in the workspace to read,
    // and the one path the task permits is writable.
    expect(run.toolResults.map((result) => result.isError)).toEqual([false, false, false])
    const threadId = run.threadId

    // The bytes are in the BUILDER'S workspace before the controller is ever constructed:
    // read them through the same reader the controller will use, from a different provider
    // instance addressing the same storage by scope, image and installation store.
    const reader = createThreadWorkspaceReader(
      { providerFor: () => builderSandboxProvider(task.target), appRoot },
      () => targetInspectionOptions(task),
    )
    const observed = await reader.read({ threadId, taskId: TASK }, AbortSignal.timeout(120_000))
    expect(observed.get(source)).toBe(repaired)
    expect(observed.get("TASK.md")).toBe(task.specText)
    // The capture is the target's `capture.include` and nothing else: `packages/devkit/templates`
    // is not in it, so the pinned package's template tree never reaches either workspace.
    expect(
      [...observed.keys()].filter((path) => path.startsWith("packages/devkit/templates/")),
    ).toEqual([])
    // The dependency tree is a root symlink inspection validates against its exact target
    // rather than walking into.
    expect(observed.has("node_modules")).toBe(false)

    worker = await createFakeWorker({
      outboxDir: join(dir, "unused"),
      run: "edits_only",
      threadId,
    })
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      worker: createHttpWorkerClient(worker.baseUrl),
      workerRoute: "/build#agent",
      exportDir,
      artifactsDir: join(dir, "artifacts"),
      verifier: createDockerVerifier(createArtifactStore(join(dir, "artifacts"))),
      workspaceReader: createThreadWorkspaceReader(
        { providerFor: () => builderSandboxProvider(task.target), appRoot },
        () => targetInspectionOptions(task),
      ),
      captureBaseline: captureTargetBaseline,
      maxActiveMs: 3 * budget,
    })
    const { id } = await factory.create({ taskId: TASK })
    await factory.dispatch(id)
    const reviewed = await factory.waitFor(
      id,
      (row) =>
        row.state === "awaiting_approval" || row.state === "blocked" || row.state === "failed",
      budget + 120_000,
    )
    expect({ state: reviewed.state, blocked: reviewed.blockedReason }).toEqual({
      state: "awaiting_approval",
      blocked: null,
    })

    const evidence = factory.evidence(id)
    // The candidate is the diff between the controller's own capture of the pin and the bytes
    // it read for itself: one changed path, the one the task permits.
    expect(evidence.candidate?.changedPaths).toEqual([source])
    expect(evidence.candidate?.baselineDigest).toBe(
      (await captureTargetBaseline(TASK, AbortSignal.timeout(60_000))).digest,
    )
    expect(evidence.receipt?.verdict).toBe("pass")
    expect(evidence.receipt?.candidateDigest).toBe(evidence.candidate?.digest)
    // Both oracles ran: the package's own suite, and the controller's copy of the independent
    // checks, which were never in the read workspace to begin with.
    expect(evidence.receipt?.checks.map((check) => check.id)).toEqual(["visible", "independent"])
    expect(evidence.receipt?.environmentIdentity).toBe(loadPolicy(TASK).environment.identity)
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
  },
  4 * budget + 120_000,
)
