import { describe, expect, it } from "vitest"
import { fixtureWorkspace, sandboxPolicy } from "../src/fixtures/workspace.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

describe("fixture workspace definition", () => {
  it("captures only the declared inventory and never the checks", () => {
    const definition = fixtureWorkspace("cli-flags")
    expect(definition.source.directory).toBe("fixtures/cli-flags/project")
    expect(definition.source.include).toContain("src/cli.ts")
    expect(definition.source.include).toContain("test/cli.test.ts")
    for (const path of definition.source.include) expect(path.startsWith("checks/")).toBe(false)
    expect(definition.baseline).toBe("git")
  })

  it("denies the network and bounds the container", () => {
    expect(sandboxPolicy.network.mode).toBe("deny")
    expect(sandboxPolicy.resources?.timeoutMs).toBeGreaterThan(0)
  })
})

describe("fake workspace reader", () => {
  it("returns the scripted bytes for a thread and rejects an unknown one", async () => {
    const reader = createFakeWorkspaceReader({ "t-1": { "src/cli.ts": "fixed\n" } })
    expect(await reader.read("t-1", AbortSignal.timeout(1_000))).toEqual(
      new Map([["src/cli.ts", "fixed\n"]]),
    )
    await expect(reader.read("t-2", AbortSignal.timeout(1_000))).rejects.toThrow(/t-2/)
  })

  it("records every thread it was asked to read", async () => {
    const reader = createFakeWorkspaceReader({ "t-1": {} })
    await reader.read("t-1", AbortSignal.timeout(1_000))
    expect(reader.reads).toEqual(["t-1"])
  })
})
