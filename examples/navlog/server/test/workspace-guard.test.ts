import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAgentHarness, script } from "@b4run/testing"
import { afterAll, describe, expect, it } from "vitest"
import config from "../b4.config.ts"

describe("b4.config.ts backends.filesystem", () => {
  it("is the guarded local filesystem: reference files refuse writes, reports do not", async () => {
    const backend = config.backends?.filesystem
    if (backend === undefined) throw new Error("b4.config.ts sets no backends.filesystem")
    const root = await mkdtemp(join(tmpdir(), "navlog-guard-"))
    try {
      const ctx = { signal: new AbortController().signal, workspaceRoot: root }
      await expect(backend.writeFile(join(root, "poh", "x.md"), "x", ctx)).rejects.toThrow(
        "poh/x.md is read-only reference material in this app; write reports under reports/",
      )
      await expect(
        backend.writeFile(join(root, "reports", "KSTP-KRST.md"), "navlog", ctx),
      ).resolves.toMatchObject({ bytesWritten: 6 })
      await expect(readFile(join(root, "reports", "KSTP-KRST.md"), "utf8")).resolves.toBe("navlog")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("the navlog agent's writeFile tool", () => {
  const appRoot = fileURLToPath(new URL("..", import.meta.url))
  const pohFile = join(appRoot, "workspace", "poh", "cruise-performance.md")
  let original: string | undefined
  const harness = createAgentHarness({ appRoot, route: "/navlog#agent" })

  afterAll(async () => {
    // Restore the corpus if the guard ever fails, so a red run cannot corrupt the repo.
    if (original !== undefined) await writeFile(pohFile, original)
    await (await harness).close()
  })

  it("cannot overwrite a POH table", async () => {
    original = await readFile(pohFile, "utf8")
    const h = await harness
    const run = await h.run({
      input: "overwrite the cruise table",
      fixtures: script()
        .user("overwrite the cruise table")
        .callsTool("writeFile", { path: "poh/cruise-performance.md", content: "tampered" })
        .replies("I could not change it."),
    })
    const result = run.toolResults.find((entry) => entry.name === "writeFile")
    expect(String(result?.content)).toContain(
      "poh/cruise-performance.md is read-only reference material in this app",
    )
    await expect(readFile(pohFile, "utf8")).resolves.toBe(original)
  }, 120_000)
})
