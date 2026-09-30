import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { createSourceBundle, type SourceBundle } from "@b4run/workspace/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The capture itself is real framework code everywhere else (see baseline.test.ts); here it
// (and the target archive it reads) is replaced by a synthetic bundle the size of a real target (the cli target captures ~343
// files), so the test measures only what the controller does with a capture once it has one.
const synthetic: { source: SourceBundle | undefined } = { source: undefined }
const counts = { verify: 0, read: 0 }

vi.mock("@b4run/workspace/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@b4run/workspace/node")>()
  return {
    ...actual,
    captureWorkspaceDefinition: async () => {
      if (!synthetic.source) throw new Error("no synthetic source")
      return { version: 1, source: synthetic.source, environmentLinks: [] }
    },
    verifySourceBundle: (value: unknown) => {
      counts.verify++
      return actual.verifySourceBundle(value)
    },
    readSourceFile: (bundle: SourceBundle, path: string) => {
      counts.read++
      return actual.readSourceFile(bundle, path)
    },
  }
})

// The target's own archive (git archive + tar, synchronous) is a separate, smaller block that
// is not what this file measures; the definition it would produce is never read here.
vi.mock("../src/lib/targets/workspace.ts", () => ({
  targetWorkspace: () => ({ source: { root: ".", include: [] } }),
}))

const { captureTargetBaseline } = await import("../src/lib/verification/baseline.ts")

const FILES = 400
const FILE_BYTES = 6 * 1024

function syntheticBundle(): { bundle: SourceBundle; texts: Map<string, string> } {
  const texts = new Map<string, string>()
  const inputs = []
  for (let i = 0; i < FILES; i++) {
    const path = `src/module-${String(i).padStart(4, "0")}.ts`
    const line = `export const value${i} = ${JSON.stringify(`é-${i}-`)} // ✓\n`
    const text = line.repeat(Math.ceil(FILE_BYTES / line.length)).slice(0, FILE_BYTES)
    texts.set(path, text)
    inputs.push({ path, bytes: new TextEncoder().encode(text), executable: i % 7 === 0 })
  }
  return { bundle: createSourceBundle(inputs), texts }
}

let captureRoot: string
beforeEach(() => {
  captureRoot = mkdtempSync(join(tmpdir(), "factory-baseline-loop-"))
  counts.verify = 0
  counts.read = 0
})
afterEach(() => {
  synthetic.source = undefined
  rmSync(captureRoot, { recursive: true, force: true })
})

describe("captureTargetBaseline over a target-sized capture", () => {
  it("verifies the bundle a constant number of times, not once per file, and decodes every file", async () => {
    const { bundle, texts } = syntheticBundle()
    synthetic.source = bundle
    const baseline = await captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000), {
      captureRoot,
    })
    expect(baseline.digest).toBe(bundle.digest)
    expect(baseline.files).toEqual(texts)
    // Each readSourceFile verifies the WHOLE bundle again, so it counts as a verification.
    expect(counts.verify + counts.read).toBeLessThanOrEqual(1)
  }, 120_000)

  it("never blocks the event loop for long while it decodes the capture", async () => {
    synthetic.source = syntheticBundle().bundle
    // The longest gap between ticks of a 10 ms interval is the longest synchronous block.
    // (monitorEventLoopDelay does not see a block that starts before its first sample: over the
    // pre-fix per-file verification, ~16 s of one block, it reported a 16 ms maximum.)
    let longest = 0
    let last = performance.now()
    const tick = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 10)
    try {
      await captureTargetBaseline("cli-flags", AbortSignal.timeout(60_000), { captureRoot })
      // A block is only seen once the loop turns again, so let a few ticks land.
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      clearInterval(tick)
    }
    expect(longest).toBeLessThan(250)
  }, 120_000)
})
