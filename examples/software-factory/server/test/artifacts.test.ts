import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createArtifactStore } from "../src/storage/artifacts.ts"

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const store = () => {
  dir = mkdtempSync(join(tmpdir(), "factory-artifacts-"))
  return createArtifactStore(join(dir, "artifacts"))
}

describe("artifact store", () => {
  it("is content addressed and returns the digest", async () => {
    const s = store()
    const ref = await s.put("hello\n")
    expect(ref.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(ref.bytes).toBe(6)
    expect(await s.read(ref.digest)).toBe("hello\n")
  })

  it("is idempotent for identical content and never rewrites", async () => {
    const s = store()
    const one = await s.put("same\n")
    const two = await s.put("same\n")
    expect(two.digest).toBe(one.digest)
    expect(readFileSync(s.pathFor(one.digest), "utf8")).toBe("same\n")
  })

  it("refuses a digest that is not a sha256 hex string", async () => {
    const s = store()
    await expect(s.read("../escape")).rejects.toThrow(/digest/i)
  })

  it("reports a missing artifact clearly", async () => {
    const s = store()
    await expect(s.read("a".repeat(64))).rejects.toThrow(/not found/i)
  })
})
