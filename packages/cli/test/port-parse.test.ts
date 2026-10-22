import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterAll, test } from "vitest"
import { runStartCommand } from "../src/commands/start.ts"
import { parsePort } from "../src/lib/dev/parse-port.ts"
import { CliError } from "../src/lib/output.ts"

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

test('A1: parsePort rejects non-decimal or out-of-range inputs ("65536", "70000", "1e3", "0x1f90") and accepts "65535".', async () => {
  // accepted boundary
  assert.equal(parsePort("65535"), 65535)

  // out of range
  assert.throws(
    () => parsePort("65536"),
    (err) => {
      assert.ok(err instanceof CliError)
      assert.equal(err.message, "Invalid port: 65536 (expected an integer from 1 to 65535)")
      assert.equal(err.exitCode, 2)
      return true
    },
  )

  assert.throws(
    () => parsePort("70000"),
    (err) => {
      assert.ok(err instanceof CliError)
      assert.equal(err.message, "Invalid port: 70000 (expected an integer from 1 to 65535)")
      assert.equal(err.exitCode, 2)
      return true
    },
  )

  // 0 is invalid here (dev and inspect allocate their own port); start accepts it
  assert.throws(
    () => parsePort("0"),
    (err) => {
      assert.ok(err instanceof CliError)
      assert.equal(err.message, "Invalid port: 0 (expected an integer from 1 to 65535)")
      assert.equal(err.exitCode, 2)
      return true
    },
  )

  // non-decimal forms rejected
  assert.throws(
    () => parsePort("1e3"),
    (err) => {
      assert.ok(err instanceof CliError)
      assert.equal(err.message, "Invalid port: 1e3 (expected an integer from 1 to 65535)")
      assert.equal(err.exitCode, 2)
      return true
    },
  )

  assert.throws(
    () => parsePort("0x1f90"),
    (err) => {
      assert.ok(err instanceof CliError)
      assert.equal(err.message, "Invalid port: 0x1f90 (expected an integer from 1 to 65535)")
      assert.equal(err.exitCode, 2)
      return true
    },
  )
})

test("A2: runStartCommand rejects an invalid --port by rejecting with a CliError whose message names the 0–65535 range and exitCode 2", async () => {
  const io = { stdout: (_: string) => {}, stderr: (_: string) => {} }

  await assert.rejects(
    async () => {
      await runStartCommand({ port: "70000" }, io)
    },
    (err) => {
      assert.ok(err instanceof CliError)
      assert.equal(err.message, "Invalid port: 70000 (expected an integer from 0 to 65535)")
      assert.equal(err.exitCode, 2)
      return true
    },
  )
})
