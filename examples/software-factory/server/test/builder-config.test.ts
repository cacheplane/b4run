import { describe, expect, it } from "vitest"
// TEMPORARY until the builder manifest lands (Task 3)
import { taskPrompt } from "../../controller/src/lib/prompts.ts"
// TEMPORARY until the builder manifest lands (Task 3)
import { loadTask } from "../../controller/src/lib/targets/catalog.ts"
import config from "../b4.config.ts"
import builder from "../src/app/build/index.ts"

describe("builder configuration", () => {
  it("denies the network and pins one image for both containers", () => {
    expect(config.sandbox?.network?.mode).toBe("deny")
    expect(config.sandbox?.provider.name).toBe("docker")
    const workspace = config.sandbox?.workspace
    if (typeof workspace === "function")
      throw new Error("builder config must declare a static workspace")
    expect(workspace?.source.directory).toBe(".factory/captures/builder/cli-flags")
  })

  it("pre-approves exactly the commands the target needs, so an interrupt is a surprise", () => {
    const bash = config.permissions?.allow?.bash ?? []
    expect(bash).toContain("npm test")
    // Prefix matching is why this has a trailing space.
    expect(bash).toContain("node ")
    expect(bash.some((pattern) => pattern.includes("rm"))).toBe(false)
  })

  it("keeps the builder's own review tools nonexistent", () => {
    // Rung 1's whole point: the builder has no channel for a verdict.
    expect(config.permissions?.allow?.tool ?? []).toEqual([])
  })
})

describe("the builder route", () => {
  it("is a bounded agent with no approval gate and no custom tool", () => {
    expect(builder.tools?.approve ?? []).toEqual([])
    expect(builder.recursionLimit).toBeGreaterThan(0)
    expect(builder.systemPrompt).toMatch(/readFile/)
    // It must not be told to verify or to export; those are the controller's.
    expect(builder.systemPrompt).not.toMatch(/prepareReview|exportForReview/)
  })

  it("derives the task's prompt from the target's own commands", () => {
    const prompt = taskPrompt(loadTask("cli-flags"))
    // The command it is told to run is the one its permissions pre-approve, because both
    // come from the target's manifest.
    expect(prompt).toContain("Run the tests with `npm test`.")
    // Reproduce first: the builder is asked to see the failure before it changes anything.
    expect(prompt).toMatch(/Reproduce the failure/)
    expect(config.permissions?.allow?.bash ?? []).toContain("npm test")
    expect(prompt).not.toMatch(/exportForReview/)
  })
})
