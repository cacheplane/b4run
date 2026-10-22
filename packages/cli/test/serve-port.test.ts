import assert from "node:assert/strict"
import { afterAll, test } from "vitest"
import { resolveServePort } from "../src/lib/dev/serve-runtime.ts"

// Import the built module from the package dist mirrored from src

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await Promise.resolve()
})

test('A1: explicitPort wins (including 0): resolveServePort(0, "65535") returns 0', async () => {
  assert.equal(resolveServePort(0, "65535"), 0)
})

test('A2: decimal-digit envPort in range is honoured: resolveServePort(undefined, "65535") returns 65535', async () => {
  assert.equal(resolveServePort(undefined, "65535"), 65535)
})

test('A3: fractional envPort falls back to default: resolveServePort(undefined, "3.5") returns 8000', async () => {
  assert.equal(resolveServePort(undefined, "3.5"), 8000)
})

test('A4: non-decimal envPort (hex) falls back to default: resolveServePort(undefined, "0x50") returns 8000', async () => {
  assert.equal(resolveServePort(undefined, "0x50"), 8000)
})
