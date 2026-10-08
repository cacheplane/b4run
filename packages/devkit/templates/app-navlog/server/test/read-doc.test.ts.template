import type { B4ToolContext } from "@b4run/sdk"
import { describe, expect, it, vi } from "vitest"
import readDoc from "../src/tools/readDoc.ts"

function context(): { ctx: B4ToolContext; readFile: ReturnType<typeof vi.fn> } {
  const readFile = vi.fn(async (path: string) => `contents of ${path}`)
  const ctx = { signal: new AbortController().signal, fs: { readFile } } as unknown as B4ToolContext
  return { ctx, readFile }
}

describe("readDoc", () => {
  it("reads the aircraft baseline, POH tables, regulations and offloaded tool outputs", async () => {
    const { ctx, readFile } = context()
    for (const path of [
      "aircraft/c172n.md",
      "poh/cruise-performance.md",
      "regs/vfr-fuel-reserves.md",
      "tool-outputs/computeNavlog-call_1.txt",
    ]) {
      expect(await readDoc({ path }, ctx)).toEqual({ content: `contents of ${path}` })
    }
    expect(readFile).toHaveBeenCalledTimes(4)
  })
  it("refuses any other path before reading", async () => {
    const { ctx, readFile } = context()
    for (const path of [
      "AGENTS.md",
      "/etc/passwd",
      "poh/../AGENTS.md",
      "aircraft/../AGENTS.md",
      "reports/x.md",
    ]) {
      await expect(readDoc({ path }, ctx)).rejects.toThrow(
        /readDoc accepts workspace paths under aircraft\/, poh\/, regs\/, tool-outputs\//,
      )
    }
    expect(readFile).not.toHaveBeenCalled()
  })
})
