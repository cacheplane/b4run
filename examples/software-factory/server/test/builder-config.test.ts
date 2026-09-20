import { describe, expect, it } from "vitest"
import config from "../b4.config.ts"
import builder from "../src/app/build/index.ts"
import { TASK_PROMPTS } from "../src/prompts.ts"

describe("builder configuration", () => {
  it("denies the network and pins one image for both containers", () => {
    expect(config.sandbox?.network?.mode).toBe("deny")
    expect(config.sandbox?.provider.name).toBe("docker")
    expect(config.sandbox?.workspace?.source.directory).toBe(".factory/captures/builder/cli-flags")
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

  it("has a prompt constant for the task, so static fixtures can key to it", () => {
    expect(TASK_PROMPTS["cli-flags"]).toMatch(/\S/)
    expect(TASK_PROMPTS["cli-flags"]).not.toMatch(/exportForReview/)
  })
})
