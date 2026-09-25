import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import { script } from "@b4run/testing"
import { afterEach, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { handedSourceDigest } from "../src/lib/controller/source-digest.ts"
import { taskPrompt } from "../src/lib/prompts.ts"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { targetInspectionOptions } from "../src/lib/targets/workspace.ts"
import { captureTargetBaseline } from "../src/lib/verification/baseline.ts"
import { createDockerVerifier } from "../src/lib/verification/docker-verifier.ts"
import { loadPolicy } from "../src/lib/verification/policy.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createHttpThreadWorkspaceReader } from "../src/lib/worker/workspace-reader.ts"
import { fakeWorkerMap } from "./fake-worker-map.ts"
import { applyReference } from "./reference-repair.ts"
import { type ServedBuilder, serveBuilder, toolCallsSeen, toolResults } from "./served-builder.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

/**
 * Layer 3 for the monorepo target: the same join the `cli-flags` lane proves, over a real
 * package pinned out of this repository. The controller dispatches to the real builder app,
 * served for the `devkit` target, whose resolver serves the work order's manifest that
 * `dispatch` wrote; the builder's own tools write the reference repair into its managed
 * workspace; the controller reads those bytes through the byte channel,
 * assembles them against ITS OWN archive of the pin, verifies them in the prepared image,
 * freezes a bundle, approves and exports exactly those bytes.
 *
 * The builder really builds and tests inside its own container here, which no other lane
 * proves: `builderPermissions(devkit)` is derived from the target's own `commands`, and only
 * a real turn shows that the derived prefixes admit those exact invocations and that the
 * dependency link resolves for them. The build is also what makes the reader's
 * `ignorePrefixes` load-bearing — it writes `packages/devkit/dist/**` into the workspace, and
 * without the filter every one of those paths would be an "added" path and a scope violation.
 * The checks themselves are still graded by the layer 2 lane
 * (`target-devkit.integration.test.ts`).
 */

const TASK = "devkit-spawn-deadline"
const task = loadTask(TASK)
const source = task.manifest.allowedSourcePaths[0] as string
// Built from the target's own commands rather than restated, so the fixture cannot drift from
// what `builderPermissions` pre-approves; the `cd` prefix is the one the builder is told to
// use, and it is the allow-list entry too.
const buildCommand = `cd ${task.target.commands.cwd} && ${task.target.commands.build.join(" ")}`
const testCommand = `cd ${task.target.commands.cwd} && ${task.target.commands.test.join(" ")}`
// Vitest colours its summary, and the tool result carries that output as JSON text, so the
// escapes arrive either raw or as their `\u001b` spelling. Stripped before the summary's
// shape is pinned, rather than pinning the colour codes.
const ANSI = new RegExp(`(?:\\\\u001b|${String.fromCodePoint(0x1b)})\\[[0-9;]*m`, "g")
// Verification is active time and this lane verifies twice (once for the receipt, again at
// approve), so every budget below is derived from the target's own deadline.
const budget = task.target.resources.verifierDeadlineMs

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

    // The one builder, which serves every target: the manifest `dispatch` writes carries the
    // devkit image, policy and permissions; its manifest directory starts empty.
    builder = await serveBuilder()
    const served = builder
    const input = taskPrompt(task)
    served.aimock.addFixtures(
      script()
        .user(input)
        .callsTool("readFile", { path: "TASK.md" })
        .callsTool("readFile", { path: source })
        .callsTool("writeFile", { path: source, content: repaired })
        .callsTool("runBash", { command: buildCommand })
        .callsTool("runBash", { command: testCommand })
        .replies("Repair complete.")
        .build(),
    )
    // The controller's half of this lane is built from `served.url` and the token alone.
    const reader = () =>
      createHttpThreadWorkspaceReader({ url: served.url, token: TEST_WORKER_TOKEN }, () =>
        targetInspectionOptions(task),
      )
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      generatedTasksDir: join(dir, "tasks"),
      captureRoot: dir,
      workers: fakeWorkerMap({
        builder: {
          client: createHttpWorkerClient(served.url, { token: TEST_WORKER_TOKEN }),
          reader: reader(),
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
      // The active clock runs from dispatch, and this lane's builder turn really builds and
      // tests inside its container before the verifier does. Four times the target's own
      // deadline is headroom for that turn and the TWO verifications (the receipt's, and the
      // one at approve).
      maxActiveMs: 4 * budget,
    })
    const { id } = await factory.create({ taskId: TASK })
    expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    const reviewed = await factory.waitFor(
      id,
      (row) =>
        row.state === "awaiting_approval" || row.state === "blocked" || row.state === "failed",
      2 * budget + 120_000,
    )
    expect({ state: reviewed.state, blocked: reviewed.blockedReason }).toEqual({
      state: "awaiting_approval",
      blocked: null,
    })
    const threadId = reviewed.workerThreadId as string
    threads.push(threadId)

    // Every tool call the builder made was admitted: the spec is in the workspace to read,
    // the one path the task permits is writable, and the target's OWN build and test
    // invocations matched `builderPermissions(devkit)` against a real container rather than
    // surfacing as an interrupt (which would have parked the turn before its last call).
    expect(toolCallsSeen(served.aimock)).toEqual([
      "readFile",
      "readFile",
      "writeFile",
      "runBash",
      "runBash",
    ])
    // The suite really ran over the repaired bytes in the builder's container, with the
    // dependency link resolving `vitest`: the summary line is vitest's own, and the runner
    // colours it, so the colour codes come out before the shape is pinned.
    const suiteOutput = String(toolResults(served.aimock)[4]).replaceAll(ANSI, "")
    expect(suiteOutput).toMatch(/Tests\s+\d+ passed/)
    expect(suiteOutput).toContain('"exitCode":0')

    // Admitted through the resolver, from the manifest `dispatch` wrote for this work order;
    // the manifest itself is gone once the turn ended.
    const written = factory.events(id).find((e) => e.type === "builder_manifest_written")?.payload
    const installation = openWorkspaceInstallationReader(served.appRoot)
    try {
      expect(installation.associations.get(threadId)?.intent.sourceDigest).toBe(
        written?.sourceDigest,
      )
    } finally {
      installation.close()
    }
    expect(await readdir(served.manifestDir)).toEqual([])

    // The bytes are in the BUILDER'S workspace: read them through the same reader the
    // controller used, over the builder's own port, naming the source `dispatch` handed it.
    const sourceDigest = handedSourceDigest(factory.events(id), threadId, "builder")
    const observed = await reader().read(
      { threadId, taskId: TASK, sourceDigest },
      AbortSignal.timeout(120_000),
    )
    // The builder's build wrote `packages/devkit/dist/**` into the workspace; the reader drops
    // every path under the target's `snapshotIgnore` prefixes, because the assembly rule
    // rejects any path the baseline lacks and build output is not a candidate. Without the
    // filter the work order would have blocked with `scope_violation`.
    expect([...observed.keys()].filter((path) => path.startsWith("packages/devkit/dist/"))).toEqual(
      [],
    )
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

    const evidence = factory.evidence(id)
    // The candidate is the diff between the controller's own capture of the pin and the bytes
    // it read for itself: one changed path, the one the task permits.
    expect(evidence.candidate?.changedPaths).toEqual([source])
    expect(evidence.candidate?.baselineDigest).toBe(
      (await captureTargetBaseline(TASK, AbortSignal.timeout(60_000), { captureRoot: dir })).digest,
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
  5 * budget + 120_000,
)
