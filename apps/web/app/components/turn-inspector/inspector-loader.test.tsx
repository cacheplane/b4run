import { webcrypto } from "node:crypto"
import { afterEach, expect, test, vi } from "vitest"
import { readCaptureAsset } from "../../../lib/turn-inspector/load-capture"
import fixture from "./__fixtures__/synthetic-capture.json"

const text = JSON.stringify(fixture)
async function digest(value: string) {
  return Buffer.from(
    await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex")
}
afterEach(() => vi.unstubAllGlobals())
test("loads only a digest-matching bounded capture", async () => {
  const hash = await digest(text)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(text)),
  )
  expect((await readCaptureAsset(hash)).id).toBe(fixture.id)
})
test("rejects tampered bytes and unsafe artifact names", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(text)),
  )
  await expect(readCaptureAsset("0".repeat(64))).rejects.toThrow(/digest/)
  await expect(readCaptureAsset("../../secret")).rejects.toThrow(/digest/)
})
test("rejects declared and actual oversized responses", async () => {
  const hash = await digest(text)
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(text, { headers: { "content-length": String(21 * 1024 * 1024) } }),
    ),
  )
  await expect(readCaptureAsset(hash)).rejects.toThrow(/limit/)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(21 * 1024 * 1024))),
  )
  await expect(readCaptureAsset(hash)).rejects.toThrow(/limit/)
})
test("rejects failed requests and invalid schemas", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 404 })),
  )
  await expect(readCaptureAsset(await digest(text))).rejects.toThrow(/404/)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}")),
  )
  await expect(readCaptureAsset(await digest("{}"))).rejects.toThrow(/capture/)
})
