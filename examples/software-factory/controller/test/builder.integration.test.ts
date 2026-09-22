import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import { createAgentHarness, script } from "@b4run/testing"
import { expect, it } from "vitest"
import { writeBuilderManifest } from "../src/lib/builder-manifest.ts"
import { taskPrompt } from "../src/lib/prompts.ts"
import { captureTarget } from "../src/lib/targets/archive.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { isolatedBuilder } from "./isolated-builder.ts"

/**
 * Layer 2: the real builder app, real typegen, real tool wiring, scripted model output. This
 * is the lane rung 0 could not build, and it works now because the builder only edits files:
 * a static fixture can script exactly that.
 *
 * Only the model is scripted. The route, the permission config, the tool loop and the
 * container are all the real ones, which is why this lives in the Docker project: the app
 * configures a sandbox, so the run acquires one. Without Docker it fails rather than
 * skipping, the way code-fixer's harness test does.
 *
 * The builder is configured by ONE input, the manifest the controller writes: the workspace
 * bytes, the sandbox policy, the image and the prompt all come from it, and the builder
 * resolves no pin and captures nothing of its own. The controller writes it here and the
 * harness — which boots the app in this process — receives it through `process.env`.
 */
it("drives the real builder to write the repaired source and nothing else", async () => {
  const appRoot = await isolatedBuilder()
  const task = loadTask("cli-flags")
  const source = task.manifest.allowedSourcePaths[0] as string
  // The controller's half: capture the target and hand the builder the bytes as data.
  const manifestDir = await mkdtemp(join(tmpdir(), "factory-builder-manifest-"))
  const manifestPath = await writeBuilderManifest(task, manifestDir)
  // The baseline bytes, from a throwaway capture of the pin under a temporary app root: the
  // same archive the manifest's workspace is built from, captured where it disturbs neither
  // the builder's nor the controller's capture directory.
  const captureRoot = await mkdtemp(join(tmpdir(), "factory-builder-baseline-"))
  const captured = captureTarget(task, "test", { appRoot: captureRoot })
  const repaired = await readFile(join(captured.absolute, source), "utf8")
  await rm(captureRoot, { recursive: true, force: true })
  // The copied `b4.config.ts` reads FACTORY_BUILDER_MANIFEST at module load and the harness
  // loads it when it starts, so the variable has to be set before `createAgentHarness`. The
  // harness takes no env of its own — it boots the app in this process — so this is
  // `process.env`, restored at the end so it cannot bleed into another file.
  const previous = process.env.FACTORY_BUILDER_MANIFEST
  process.env.FACTORY_BUILDER_MANIFEST = manifestPath
  // Constructed INSIDE the try: a harness that throws while booting (a manifest the config
  // refuses, a typegen failure) must still leave the variable and the temporary directories
  // as it found them, or the next file in the project inherits them.
  let harness: Awaited<ReturnType<typeof createAgentHarness>> | undefined
  try {
    harness = await createAgentHarness({ appRoot, route: "/build#agent" })
    const input = taskPrompt(task)
    const run = await harness.run({
      input,
      fixtures: script()
        .user(input)
        .callsTool("readFile", { path: "TASK.md" })
        .callsTool("runBash", { command: "npm test" })
        .callsTool("writeFile", { path: source, content: `${repaired}// repaired\n` })
        .callsTool("runBash", { command: "npm test" })
        .replies("Repair complete.")
        .build(),
    })

    // The builder produced no interrupt, because it has no gate to park on.
    expect(run.interrupts).toHaveLength(0)
    const called = run.toolCalls.map((call) => call.name)
    expect(called).toEqual(["readFile", "runBash", "writeFile", "runBash"])
    // It has no verdict channel at all.
    expect(called).not.toContain("prepareReview")
    expect(called).not.toContain("exportForReview")

    // Every tool actually ran. Without this the assertions above would hold
    // even if the permission config had denied all four calls, which is most
    // of what this lane exists to exercise.
    expect(
      run.toolResults.map((result) => ({ name: result.name, isError: result.isError })),
    ).toEqual([
      { name: "readFile", isError: false },
      { name: "runBash", isError: false },
      { name: "writeFile", isError: false },
      { name: "runBash", isError: false },
    ])
    // The bash results came out of a container that really ran the fixture's own
    // test command, and the first reproduced the documented failure, so the
    // workspace the manifest carried really is the faulty baseline. Only the first
    // is pinned to the failure: the scripted write is deliberately not a repair,
    // but a later script that applies the reference patch should not break here.
    const bash = run.toolResults.filter((result) => result.name === "runBash")
    for (const result of bash) expect(String(result.content)).toContain("b4-fixture-cli-flags")
    expect(String(bash[0]?.content)).toContain("unknown option")

    // The workspace the builder SERVED is the one the controller captured, byte for byte.
    // The builder no longer captures anything — the controller does, at manifest time — so
    // the identity of the published workspace record against the manifest's own source
    // digest is what says the builder started from the intended baseline and not from some
    // archive of its own.
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      workspace: { source: { digest: string } }
    }
    const installation = openWorkspaceInstallationReader(appRoot)
    try {
      const record = installation.associations.get(run.threadId)
      // Asserted on its own: a thread with no record at all would otherwise fail as an
      // undefined digest, which reads like a capture mismatch and is not one.
      expect(record).toBeDefined()
      expect(record?.intent.sourceDigest).toBe(manifest.workspace.source.digest)
    } finally {
      installation.close()
    }
  } finally {
    await harness?.close({ destroyWorkspaces: true })
    if (previous === undefined) delete process.env.FACTORY_BUILDER_MANIFEST
    else process.env.FACTORY_BUILDER_MANIFEST = previous
    await rm(manifestDir, { recursive: true, force: true })
    await rm(appRoot, { recursive: true, force: true })
  }
}, 300_000)
