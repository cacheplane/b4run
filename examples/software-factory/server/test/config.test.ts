import { describe, expect, it } from "vitest"
import { loadConfig } from "../src/config.ts"

const base = {
  FACTORY_WORKER_URL: "http://127.0.0.1:4100",
  FACTORY_WORKER_OUTBOX: "/tmp/outbox",
  FACTORY_STATE_DIR: "/tmp/state",
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base)
    expect(config.workerRoute).toBe("/fix#agent")
    expect(config.approvalTtlMs).toBe(900_000)
    expect(config.maxActiveMs).toBe(1_200_000)
    expect(config.receiptWaitMs).toBe(180_000)
    expect(config.registryPath).toBe("/tmp/state/registry.sqlite")
    expect(config.httpPort).toBe(4300)
  })

  it("rejects missing or malformed values", () => {
    expect(() => loadConfig({})).toThrow(/FACTORY_WORKER_URL/)
    expect(() => loadConfig({ ...base, FACTORY_APPROVAL_TTL_MS: "soon" })).toThrow(
      /FACTORY_APPROVAL_TTL_MS/,
    )
    expect(() => loadConfig({ ...base, FACTORY_WORKER_URL: "ftp://x" })).toThrow(
      /FACTORY_WORKER_URL/,
    )
  })
})
