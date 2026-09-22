import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("documented dry-run flag reaches the handler", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "memory", "consolidate", "--dry-run"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { action: "consolidate", dryRun: true })
})
