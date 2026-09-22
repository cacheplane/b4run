import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { exportApproved } from "../src/lib/delivery/export.ts"

/**
 * A write that creates its file and then dies part-way through the body: a full disk, a
 * killed process, a pulled plug. Whatever it tears, it must not be the receipt itself.
 */
const torn = vi.hoisted(() => ({ on: false }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    async writeFile(path: string, data: string, options?: Parameters<typeof actual.writeFile>[2]) {
      if (!torn.on) return actual.writeFile(path, data, options)
      await actual.writeFile(path, data.slice(0, 8), options)
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" })
    },
  }
})
afterEach(() => {
  torn.on = false
})

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const out = () => {
  dir = mkdtempSync(join(tmpdir(), "factory-export-"))
  return join(dir, "out")
}

const bundle = {
  digest: "a".repeat(64),
  workOrderId: "wo-1",
  candidateDigest: "b".repeat(64),
  receiptId: "rc-1",
  payload: { repositoryId: "cli-flags", operation: "export-local" as const },
  frozenAt: "2026-09-18T00:00:00.000Z",
}
const changes = { "src/cli.ts": "fixed\n" }

describe("exportApproved", () => {
  it("writes a receipt named by the bundle digest", async () => {
    const directory = out()
    const path = await exportApproved({ directory, bundle, changes })
    expect(readdirSync(directory)).toEqual([`${bundle.digest}.json`])
    const written = JSON.parse(readFileSync(path, "utf8"))
    expect(written.bundle.digest).toBe(bundle.digest)
    expect(written.changes).toEqual(changes)
  })

  it("is idempotent for identical content", async () => {
    const directory = out()
    const one = await exportApproved({ directory, bundle, changes })
    const two = await exportApproved({ directory, bundle, changes })
    expect(two).toBe(one)
    expect(readdirSync(directory)).toHaveLength(1)
  })

  it("leaves no half-written receipt behind when the write tears, and the retry succeeds", async () => {
    const directory = out()
    torn.on = true
    await expect(exportApproved({ directory, bundle, changes })).rejects.toThrow(/no space left/)
    // Nothing under the bundle digest: a torn body under that name would be indistinguishable
    // from a delivery, and — since differing content is refused — permanently unexportable.
    expect(readdirSync(directory)).toEqual([])

    torn.on = false
    const path = await exportApproved({ directory, bundle, changes })
    expect(readdirSync(directory)).toEqual([`${bundle.digest}.json`])
    expect(JSON.parse(readFileSync(path, "utf8")).changes).toEqual(changes)
  })

  it("refuses to overwrite a receipt whose content would differ", async () => {
    const directory = out()
    await exportApproved({ directory, bundle, changes })
    await expect(
      exportApproved({ directory, bundle, changes: { "src/cli.ts": "different\n" } }),
    ).rejects.toThrow(/already exported/i)
  })
})
