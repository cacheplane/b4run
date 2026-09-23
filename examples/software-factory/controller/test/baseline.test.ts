import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { captureTargetBaseline } from "../src/lib/verification/baseline.ts"

let captureRoot: string
beforeEach(() => {
  captureRoot = mkdtempSync(join(tmpdir(), "factory-baseline-"))
})
afterEach(() => {
  rmSync(captureRoot, { recursive: true, force: true })
})

describe("captureTargetBaseline", () => {
  it("captures the cli-flags baseline from the pin with the task spec as TASK.md", async () => {
    const baseline = await captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000), {
      captureRoot,
    })
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
    const again = await captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000), {
      captureRoot,
    })
    expect(again.digest).toBe(baseline.digest)
  })

  it("runs two concurrent captures of the same task without either clobbering the other, and leaves nothing behind", async () => {
    const [one, two] = await Promise.all([
      captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000), { captureRoot }),
      captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000), { captureRoot }),
    ])
    expect(one.digest).toBe(two.digest)
    const controllerCaptures = join(captureRoot, "captures", "controller")
    const leftover = existsSync(controllerCaptures)
      ? readdirSync(controllerCaptures).filter((name) => name.startsWith("cli-flags."))
      : []
    expect(leftover).toEqual([])
  })
})
