import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import test from "node:test"

// Runs the BUILT artifact from the workspace root, the way a consumer would, in a child whose
// event loop is left to drain: a timer the repair forgot keeps that child alive. Inputs are
// disjoint from the visible regression test (a different path, a different deadline, real
// time), so a repair that special-cases the visible fixture does not pass here.
const dist = join(process.cwd(), "packages/devkit/dist/testing/index.js")

test("A1: a spawn that fails asynchronously leaves no deadline timer running", () => {
  const program = `
    import(${JSON.stringify(dist)}).then(async ({ spawnProcess }) => {
      const missing = "/nonexistent/b4-factory-check-" + process.pid
      let rejected = false
      try { await spawnProcess({ command: missing, timeoutMs: 170000 }) } catch { rejected = true }
      if (!rejected) { console.error("did not reject"); process.exitCode = 2 }
    })
  `
  const started = Date.now()
  const result = spawnSync(process.execPath, ["-e", program], { encoding: "utf8", timeout: 8_000 })
  const elapsed = Date.now() - started
  assert.equal(
    result.status,
    0,
    `child exit ${String(result.status)} signal ${String(result.signal)}: ${result.stderr}`,
  )
  assert.ok(elapsed < 2_000, `the child's event loop stayed alive for ${elapsed}ms after the rejection`)
})
