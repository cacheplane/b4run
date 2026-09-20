import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { describe, expect, it } from "vitest"
import { fixtureWorkspace } from "../src/fixtures/workspace.ts"
import { appRoot } from "../src/targets/catalog.ts"
import { captureFixtureBaseline, captureTargetBaseline } from "../src/verification/baseline.ts"

describe("captureTargetBaseline", () => {
  it("captures the cli-flags baseline from the pin with the task spec as TASK.md", async () => {
    const baseline = await captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000))
    expect(baseline.digest).toMatch(/^[a-f0-9]{64}$/)
    expect([...baseline.files.keys()].sort()).toEqual(
      [
        "LICENSE",
        "TASK.md",
        "package-lock.json",
        "package.json",
        "src/cli.ts",
        "src/memory.ts",
        "test/cli.test.ts",
        ".gitignore",
      ].sort(),
    )
    expect(baseline.files.get("src/cli.ts")).toContain("commander")
    expect(baseline.files.get("TASK.md")).toContain("Repair CLI flag forwarding")
    const again = await captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000))
    expect(again.digest).toBe(baseline.digest)
  })

  it("runs two concurrent captures of the same task without either clobbering the other, and leaves nothing behind", async () => {
    const [one, two] = await Promise.all([
      captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000)),
      captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000)),
    ])
    expect(one.digest).toBe(two.digest)
    const controllerCaptures = join(appRoot, ".factory", "captures", "controller")
    const leftover = existsSync(controllerCaptures)
      ? readdirSync(controllerCaptures).filter((name) => name.startsWith("cli-flags."))
      : []
    expect(leftover).toEqual([])
  })

  // Bridge until src/fixtures is retired: the builder still captures the working-tree fixture
  // while the controller archives the pin; this pins the two to the same bytes.
  it("agrees with the fixture bridge on the cli-flags bytes", async () => {
    const target = await captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000))
    const fixture = await captureWorkspaceDefinition(appRoot, fixtureWorkspace("cli-flags"), {
      signal: AbortSignal.timeout(60_000),
    })
    expect(target.digest).toBe(fixture.source.digest)
    expect(captureFixtureBaseline).toBe(captureTargetBaseline)
  })
})
