import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { receiptExists, receiptPath, waitForReceipt } from "../src/worker/outbox.ts"

const digest = "c".repeat(64)
let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("outbox", () => {
  it("names the receipt by digest and reports presence", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-outbox-"))
    expect(receiptPath(dir, digest)).toBe(join(dir, `${digest}.json`))
    expect(await receiptExists(dir, digest)).toBe(false)
    writeFileSync(receiptPath(dir, digest), "{}")
    expect(await receiptExists(dir, digest)).toBe(true)
  })

  it("waits for a receipt that appears later and gives up on time", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-outbox-"))
    setTimeout(() => writeFileSync(receiptPath(dir, digest), "{}"), 60)
    expect(await waitForReceipt(dir, digest, { timeoutMs: 2_000, intervalMs: 10 })).toBe(
      receiptPath(dir, digest),
    )
    expect(await waitForReceipt(dir, "d".repeat(64), { timeoutMs: 50, intervalMs: 10 })).toBeNull()
  })
})
