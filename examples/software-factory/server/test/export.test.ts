import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { exportApproved } from "../src/delivery/export.ts"

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

  it("refuses to overwrite a receipt whose content would differ", async () => {
    const directory = out()
    await exportApproved({ directory, bundle, changes })
    await expect(
      exportApproved({ directory, bundle, changes: { "src/cli.ts": "different\n" } }),
    ).rejects.toThrow(/already exported/i)
  })
})
