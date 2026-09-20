import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentHarness, script } from "@b4run/testing"
import { expect, it } from "vitest"
import { taskPrompt } from "../src/prompts.ts"
import { captureTarget } from "../src/targets/archive.ts"
import { loadTask } from "../src/targets/catalog.ts"
import { isolatedApp } from "./isolated-app.ts"

/**
 * Layer 2: the real builder route, real typegen, real tool wiring, scripted model
 * output. This is the lane rung 0 could not build, and it works now because the
 * builder only edits files: a static fixture can script exactly that.
 *
 * Only the model is scripted. The route, the permission config, the tool loop and
 * the container are all the real ones, which is why this lives in the Docker
 * project: the app configures a sandbox, so the run acquires one. Without Docker
 * it fails rather than skipping, the way code-fixer's harness test does.
 */
it("drives the real builder to write the repaired source and nothing else", async () => {
  const appRoot = await isolatedApp()
  const task = loadTask("cli-flags")
  const source = task.manifest.allowedSourcePaths[0] as string
  // The baseline bytes, from a throwaway capture of the pin under a temporary app root: the
  // same archive the builder's own workspace is built from, captured where it disturbs
  // neither the builder's nor the controller's capture directory.
  const captureRoot = await mkdtemp(join(tmpdir(), "factory-builder-baseline-"))
  const captured = captureTarget(task, "test", { appRoot: captureRoot })
  const repaired = await readFile(join(captured.absolute, source), "utf8")
  await rm(captureRoot, { recursive: true, force: true })
  const harness = await createAgentHarness({ appRoot, route: "/build#agent" })
  try {
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
    // workspace the route captured really is the faulty baseline. Only the first
    // is pinned to the failure: the scripted write is deliberately not a repair,
    // but a later script that applies the reference patch should not break here.
    const bash = run.toolResults.filter((result) => result.name === "runBash")
    for (const result of bash) expect(String(result.content)).toContain("b4-fixture-cli-flags")
    expect(String(bash[0]?.content)).toContain("unknown option")

    // The write landed inside the builder's workspace, not in the archive it was
    // materialised from: the capture the route took is still the baseline.
    expect(
      await readFile(join(appRoot, ".factory", "captures", "builder", task.id, source), "utf8"),
    ).toBe(repaired)
  } finally {
    await harness.close({ destroyWorkspaces: true })
    await rm(appRoot, { recursive: true, force: true })
  }
}, 300_000)
