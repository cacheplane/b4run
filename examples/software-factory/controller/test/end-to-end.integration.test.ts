import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import { script } from "@b4run/testing"
import { afterEach, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { taskPrompt } from "../src/lib/prompts.ts"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { builderSandboxProvider, targetInspectionOptions } from "../src/lib/targets/workspace.ts"
import { captureTargetBaseline } from "../src/lib/verification/baseline.ts"
import { createDockerVerifier } from "../src/lib/verification/docker-verifier.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createThreadWorkspaceReader } from "../src/lib/worker/workspace-reader.ts"
import { fakeWorkerMap } from "./fake-worker-map.ts"
import { applyReference } from "./reference-repair.ts"
import { type ServedBuilder, serveBuilder, toolCallsSeen, toolResults } from "./served-builder.ts"

/**
 * The join: bytes the BUILDER'S OWN TOOLS wrote into its managed workspace during a real
 * turn the CONTROLLER dispatched, read out by the controller's own reader, assembled against
 * the controller's own captured baseline, verified in the controller's own container, frozen
 * into a bundle and exported.
 *
 * What is real here: the controller's `dispatch` (it writes the work order's builder manifest
 * into the builder's manifest directory and creates the thread with `{ factoryWorkOrderId }`),
 * the builder app served by `serveRuntime` for the `cli-flags` target, its per-work-order
 * resolver, its route, tools and permission config, its managed workspace (a
 * `b4-ws-volume-*` published under the builder's installation), the Agent Protocol between
 * the two, the reader (a separate read-only container over that volume, resolved through the
 * builder's installation store), the captured baseline, the assembly, the verifier, the
 * bundle and the export. What is not: the model is scripted (aimock).
 */

const task = loadTask("cli-flags")
const source = task.manifest.allowedSourcePaths[0] as string
const input = taskPrompt(task)

let factory: Factory | undefined
let builder: ServedBuilder | undefined
const threads: string[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await factory?.close()
  factory = undefined
  await builder?.close(threads.splice(0))
  builder = undefined
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
  // checkpoints are this test's and nobody else's, served for every target. Its
  // manifest directory starts empty: `dispatch` writes the work order's manifest there.
  builder = await serveBuilder()
  const served = builder
  served.aimock.addFixtures(
    script()
      .user(input)
      .callsTool("readFile", { path: "TASK.md" })
      .callsTool("writeFile", { path: source, content: repaired })
      .callsTool("runBash", { command: "npm test" })
      .replies("Repair complete.")
      .build(),
  )
  const reader = () =>
    createThreadWorkspaceReader(
      { providerFor: () => builderSandboxProvider(), appRoot: served.appRoot },
      () => targetInspectionOptions(task),
    )
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "tasks"),
    captureRoot: dir,
    workers: fakeWorkerMap({
      builder: {
        client: createHttpWorkerClient(served.url),
        reader: reader(),
        appRoot: served.appRoot,
        manifestDir: served.manifestDir,
      },
    }),
    exportDir,
    artifactsDir: join(dir, "artifacts"),
    verifier: createDockerVerifier(createArtifactStore(join(dir, "artifacts")), {
      stagingRoot: dir,
    }),
    captureBaseline: (taskId, signal) =>
      captureTargetBaseline(taskId, signal, { captureRoot: dir }),
  })
  const { id } = await factory.create({ taskId: "cli-flags" })
  expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
  const reviewed = await factory.waitFor(
    id,
    (row) => row.state === "awaiting_approval" || row.state === "blocked" || row.state === "failed",
    600_000,
  )
  expect({ state: reviewed.state, blocked: reviewed.blockedReason }).toEqual({
    state: "awaiting_approval",
    blocked: null,
  })
  const threadId = reviewed.workerThreadId as string
  threads.push(threadId)

  // The bytes really are in the builder's workspace: its own tools put them there and the
  // fixture's test command ran over them in the container.
  expect(toolCallsSeen(served.aimock)).toEqual(["readFile", "writeFile", "runBash"])
  expect(toolResults(served.aimock)[2]).toContain("b4-fixture-cli-flags")

  // The thread was admitted THROUGH the resolver, from the manifest `dispatch` wrote for this
  // work order: the builder's installation store associates it with that manifest's digest.
  // And the manifest is gone once the turn ended: it was needed once, at admission.
  const written = factory.events(id).find((e) => e.type === "builder_manifest_written")?.payload
  expect(written?.path).toBe(join(served.manifestDir, `${id}.json`))
  const installation = openWorkspaceInstallationReader(served.appRoot)
  try {
    expect(installation.associations.get(threadId)?.intent.sourceDigest).toBe(written?.sourceDigest)
  } finally {
    installation.close()
  }
  expect(await readdir(served.manifestDir)).toEqual([])
  expect(factory.events(id).map((e) => e.type)).toContain("builder_manifest_removed")

  // Read while the thread is IDLE BETWEEN TURNS, with its session container still alive:
  // one of the two states the read surface is specified for, and the one `docker exec` into
  // the builder could never serve safely. A DIFFERENT provider instance, as the controller is
  // a different process in production, addressing the same storage by scope, image and the
  // builder's installation store.
  const observed = await reader().read(
    { threadId, taskId: "cli-flags" },
    AbortSignal.timeout(120_000),
  )
  expect(observed.get(source)).toBe(repaired)
  expect(observed.get("TASK.md")).toBe(task.specText)
  // Both structural inspection options are load-bearing against real Docker: the git
  // directory is excluded rather than reported as added paths, and the `node_modules`
  // symlink is validated against its exact target rather than walked into. Without either,
  // the read above would have thrown or produced a scope violation below.
  expect([...observed.keys()].filter((path) => path.startsWith(".git/"))).toEqual([])
  // The git directory is EXCLUDED, not absent: `.gitignore` is part of the captured
  // baseline and must survive, so the exclusion has to be a root-directory rule.
  expect(observed.has(".gitignore")).toBe(true)
  expect(observed.has("node_modules")).toBe(false)
  // Reading disturbed nothing, and the manifest's removal cost the thread nothing: the
  // builder's next turn runs its tools in the same session and workspace, admitted long ago.
  served.aimock.addFixtures(
    script()
      .user("Confirm the file.")
      .callsTool("readFile", { path: source })
      .replies("Confirmed.")
      .build(),
  )
  expect((await served.runTurn(threadId, "Confirm the file.")).status).toBe(200)
  // The repaired bytes, read back by the builder's own tool on a turn the resolver took no
  // part in.
  expect(toolResults(served.aimock).at(-1)).toContain(repaired.trimEnd())

  const evidence = factory.evidence(id)
  // The candidate is the diff between the controller's captured baseline and the bytes it
  // read for itself: one changed path, the one the builder is allowed to write.
  expect(evidence.candidate?.changedPaths).toEqual([source])
  expect(evidence.candidate?.baselineDigest).toBe(
    (await captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000), { captureRoot: dir }))
      .digest,
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
