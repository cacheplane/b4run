import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createAgentHarness, script } from "@b4run/testing"
import { expect, it } from "vitest"
import { loadFixture } from "../src/fixtures/catalog.ts"
import { TASK_PROMPTS } from "../src/prompts.ts"
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
  const fixture = loadFixture("cli-flags")
  const source = fixture.manifest.allowedSourcePaths[0] as string
  const baseline = join(fixture.directory, "project", source)
  const repaired = await readFile(baseline, "utf8")
  const harness = await createAgentHarness({ appRoot, route: "/build#agent" })
  try {
    const input = TASK_PROMPTS["cli-flags"] as string
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

    // The write landed inside the builder's workspace, not in the app it was
    // materialised from: the fixture the route captures is still the baseline.
    expect(await readFile(join(appRoot, "fixtures", fixture.id, "project", source), "utf8")).toBe(
      repaired,
    )
  } finally {
    await harness.close({ destroyWorkspaces: true })
    await rm(appRoot, { recursive: true, force: true })
  }
}, 300_000)
