import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DRAFTER_IMAGE, loadConfig } from "../src/lib/config.ts"

const base = {
  FACTORY_WORKER_URL: "http://127.0.0.1:4100",
  FACTORY_STATE_DIR: "/tmp/state",
  FACTORY_BUILDER_APP_ROOT: "/tmp/builder",
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base)
    expect(config.workerRoute).toBe("/build#agent")
    expect(config.approvalTtlMs).toBe(900_000)
    expect(config.maxActiveMs).toBe(1_200_000)
    expect(config.registryPath).toBe("/tmp/state/registry.sqlite")
    expect(config.builderAppRoot).toBe("/tmp/builder")
  })

  it("rejects missing or malformed values", () => {
    expect(() => loadConfig({})).toThrow(/FACTORY_WORKER_URL/)
    expect(() => loadConfig({ ...base, FACTORY_APPROVAL_TTL_MS: "soon" })).toThrow(
      /FACTORY_APPROVAL_TTL_MS/,
    )
    expect(() => loadConfig({ ...base, FACTORY_WORKER_URL: "ftp://x" })).toThrow(
      /FACTORY_WORKER_URL/,
    )
    const { FACTORY_BUILDER_APP_ROOT: _omitted, ...withoutBuilderRoot } = base
    expect(() => loadConfig(withoutBuilderRoot)).toThrow(/FACTORY_BUILDER_APP_ROOT is required/)
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

describe("intake configuration", () => {
  it("defaults the intake route and leaves the intake task unset", () => {
    const config = loadConfig(base)
    expect(config.intakeRoute).toBe("/intake#agent")
    expect(config.intakeTaskId).toBeUndefined()
    // Absent, not present-and-undefined: the runtime spreads this into FactoryOptions under
    // exactOptionalPropertyTypes, so an explicit undefined would be a type error there.
    expect(Object.keys(config)).not.toContain("intakeTaskId")
  })

  it("takes an explicit intake route and intake task", () => {
    const config = loadConfig({
      ...base,
      FACTORY_INTAKE_ROUTE: "/draft#agent",
      FACTORY_INTAKE_TASK: "devkit-spawn-deadline",
    })
    expect(config.intakeRoute).toBe("/draft#agent")
    expect(config.intakeTaskId).toBe("devkit-spawn-deadline")
  })

  it("rejects a blank intake route or task", () => {
    expect(() => loadConfig({ ...base, FACTORY_INTAKE_ROUTE: "" })).toThrow(/FACTORY_INTAKE_ROUTE/)
    expect(() => loadConfig({ ...base, FACTORY_INTAKE_TASK: "" })).toThrow(/FACTORY_INTAKE_TASK/)
  })
})

describe("drafter configuration", () => {
  it("leaves the drafter app root unset and defaults the image to the pinned digest", () => {
    const config = loadConfig(base)
    expect(config.drafterAppRoot).toBeUndefined()
    expect(Object.keys(config)).not.toContain("drafterAppRoot")
    expect(config.drafterImage).toBe(DRAFTER_IMAGE)
  })

  it("takes an explicit drafter app root and image", () => {
    const config = loadConfig({
      ...base,
      FACTORY_DRAFTER_APP_ROOT: "/srv/drafter",
      FACTORY_DRAFTER_IMAGE: `node:24-slim@sha256:${"b".repeat(64)}`,
    })
    expect(config.drafterAppRoot).toBe("/srv/drafter")
    expect(config.drafterImage).toBe(`node:24-slim@sha256:${"b".repeat(64)}`)
  })

  it("rejects a blank drafter app root or image", () => {
    expect(() => loadConfig({ ...base, FACTORY_DRAFTER_APP_ROOT: "" })).toThrow(
      /FACTORY_DRAFTER_APP_ROOT/,
    )
    expect(() => loadConfig({ ...base, FACTORY_DRAFTER_IMAGE: "" })).toThrow(
      /FACTORY_DRAFTER_IMAGE/,
    )
  })

  it("pins the default image to the drafter's own, which the controller does not import", () => {
    // The image is half of the provider's identity: a controller reading with a different
    // one opens no workspace. The drafter's source is read here as text, so the equality is
    // proven without the controller importing it.
    const source = readFileSync(
      new URL("../../drafter/src/drafter-image.ts", import.meta.url),
      "utf8",
    )
    const match = source.match(/export const DRAFTER_IMAGE =\s*"([^"]+)"/)
    expect(match?.[1]).toBe(DRAFTER_IMAGE)
  })
})
