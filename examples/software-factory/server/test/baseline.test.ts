import { describe, expect, it } from "vitest"
import { captureTargetBaseline } from "../src/verification/baseline.ts"

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
})
