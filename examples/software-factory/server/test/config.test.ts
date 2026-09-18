import { describe, expect, it } from "vitest"
import { loadConfig } from "../src/config.ts"

const base = {
  FACTORY_WORKER_URL: "http://127.0.0.1:4100",
  FACTORY_STATE_DIR: "/tmp/state",
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base)
    expect(config.workerRoute).toBe("/build#agent")
    expect(config.approvalTtlMs).toBe(900_000)
    expect(config.maxActiveMs).toBe(1_200_000)
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

describe("rung 1 configuration", () => {
  it("defaults the export and artifact directories under the state directory", () => {
    const config = loadConfig(base)
    expect(config.exportDir).toBe("/tmp/state/exports")
    expect(config.artifactsDir).toBe("/tmp/state/artifacts")
    expect(config.maxChangedBytes).toBe(1024 * 1024)
    expect(config.workerRoute).toBe("/build#agent")
  })

  it("takes explicit export, artifact and cap settings", () => {
    const config = loadConfig({
      ...base,
      FACTORY_EXPORT_DIR: "/srv/out",
      FACTORY_ARTIFACTS_DIR: "/srv/evidence",
      FACTORY_MAX_CHANGED_BYTES: "4096",
    })
    expect(config.exportDir).toBe("/srv/out")
    expect(config.artifactsDir).toBe("/srv/evidence")
    expect(config.maxChangedBytes).toBe(4096)
  })

  it("no longer requires or accepts an outbox", () => {
    expect(Object.keys(loadConfig(base))).not.toContain("outboxDir")
    // The rung 0 variables are simply ignored rather than rejected, so an old
    // environment keeps working while an operator updates it.
    expect(() => loadConfig({ ...base, FACTORY_WORKER_OUTBOX: "/tmp/old" })).not.toThrow()
    expect(() => loadConfig({ ...base, FACTORY_RECEIPT_WAIT_MS: "180000" })).not.toThrow()
    expect(Object.keys(loadConfig(base))).not.toContain("receiptWaitMs")
  })

  it("rejects a non-positive byte cap", () => {
    expect(() => loadConfig({ ...base, FACTORY_MAX_CHANGED_BYTES: "0" })).toThrow(
      /FACTORY_MAX_CHANGED_BYTES/,
    )
  })
})
