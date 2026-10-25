import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runTagged0153Capture } from "../capture-v0.15.3-terminal.mjs"
import { canonicalTerminalRecordBytes } from "../terminal-record-store.mjs"
import { tagged0153Record } from "./support/tagged-0153-record-fixture.mjs"

const REVIEWED = "4".repeat(40)

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "tagged-recovery-cli-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const output = join(dir, "capture.json")
  const bytes = canonicalTerminalRecordBytes(tagged0153Record())
  let captures = 0
  return {
    output,
    bytes,
    captures: () => captures,
    args: ["--reviewed-commit", REVIEWED, "--output", output],
    dependencies: {
      cwd: dir,
      readCheckout: async () => ({ head: REVIEWED, status: "" }),
      createReaders: () => ({ github: {}, npm: {} }),
      capture: async () => {
        captures++
        return bytes
      },
    },
  }
}

test("capture CLI writes validated canonical bytes once with private permissions", async (t) => {
  const f = await fixture(t)

  const result = await runTagged0153Capture(f.args, f.dependencies)

  assert.equal(result.output, f.output)
  assert.deepEqual(await readFile(f.output), f.bytes)
  assert.equal((await stat(f.output)).mode & 0o777, 0o600)
  assert.equal(f.captures(), 1)
  await assert.rejects(runTagged0153Capture(f.args, f.dependencies), /exists/iu)
  assert.equal(f.captures(), 1)
})

test("capture CLI refuses changed or dirty checkouts and nonexact arguments before reading services", async (t) => {
  const f = await fixture(t)
  const invalid = [
    [],
    [...f.args, "--force"],
    ["--reviewed-commit", REVIEWED, "--reviewed-commit", REVIEWED],
    ["--reviewed-commit", "bad", "--output", f.output],
  ]
  for (const args of invalid) await assert.rejects(runTagged0153Capture(args, f.dependencies))
  for (const checkout of [
    { head: "9".repeat(40), status: "" },
    { head: REVIEWED, status: " M scripts/release/terminal-record-store.mjs" },
  ]) {
    await assert.rejects(
      runTagged0153Capture(f.args, { ...f.dependencies, readCheckout: async () => checkout }),
      /checkout/iu,
    )
  }
  assert.equal(f.captures(), 0)
})

test("capture CLI refuses malformed returned bytes and preserves an output created during capture", async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    runTagged0153Capture(f.args, { ...f.dependencies, capture: async () => Buffer.from("{}") }),
  )
  await assert.rejects(
    runTagged0153Capture(f.args, {
      ...f.dependencies,
      capture: async () => {
        await writeFile(f.output, "someone else's evidence")
        return f.bytes
      },
    }),
    /EEXIST/iu,
  )
  assert.equal(await readFile(f.output, "utf8"), "someone else's evidence")
})

test("capture CLI diagnostics do not expose the token", () => {
  const token = "private-fixture-token-never-print"

  const result = spawnSync(
    process.execPath,
    [new URL("../capture-v0.15.3-terminal.mjs", import.meta.url).pathname, "--invalid"],
    { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: token } },
  )

  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes("capture failed"))
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token))
})
