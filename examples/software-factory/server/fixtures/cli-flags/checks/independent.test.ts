import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8" })
test("forwards cap and memory-level cwd", () => {
  const result = run("memory", "--cwd", "/workspace/app", "prune", "--cap", "17")
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { action: "prune", cap: 17, cwd: "/workspace/app" })
})
test("rejects unknown and incomplete arguments", () => {
  for (const args of [["--bad"], ["memory", "prune", "--cap"], ["memory", "prune", "--cap", "not-a-number"], ["memory", "consolidate", "--bad"], ["memory", "consolidate", "--dry-run", "--bad"]]) {
    assert.notEqual(run(...args).status, 0, JSON.stringify(args))
  }
})
test("dry-run preserves memory state and creates no files", async () => {
  const app = await mkdtemp(join(tmpdir(), "fixture-dry-run-"))
  const state = '[{"id":"m1","content":"keep this"}]'
  try {
    await writeFile(join(app, "memory.json"), state)
    const result = run("memory", "--cwd", app, "consolidate", "--dry-run")
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { action: "consolidate", dryRun: true, cwd: app })
    assert.deepEqual(await readdir(app), ["memory.json"])
    assert.equal(await readFile(join(app, "memory.json"), "utf8"), state)
  } finally { await rm(app, { recursive: true, force: true }) }
})
