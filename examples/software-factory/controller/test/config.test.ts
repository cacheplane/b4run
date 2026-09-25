import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEFAULT_WORKER_ROUTE, DRAFTER_IMAGE, loadConfig } from "../src/lib/config.ts"

const base = {
  FACTORY_WORKER_URL: "http://127.0.0.1:4100",
  FACTORY_STATE_DIR: "/tmp/state",
  FACTORY_BUILDER_APP_ROOT: "/tmp/builder",
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base)
    expect(config.approvalTtlMs).toBe(900_000)
    expect(config.maxActiveMs).toBe(1_200_000)
    expect(config.registryPath).toBe("/tmp/state/registry.sqlite")
  })

  it("rejects missing or malformed values", () => {
    expect(() => loadConfig({})).toThrow(/FACTORY_STATE_DIR is required/)
    expect(() => loadConfig({ FACTORY_STATE_DIR: "/tmp/state" })).toThrow(
      /FACTORY_WORKER_URL is required/,
    )
    expect(() => loadConfig({ ...base, FACTORY_APPROVAL_TTL_MS: "soon" })).toThrow(
      /FACTORY_APPROVAL_TTL_MS/,
    )
    expect(() => loadConfig({ ...base, FACTORY_WORKER_URL: "ftp://x" })).toThrow(
      /FACTORY_WORKER_URL/,
    )
  })
})

describe("the builder endpoint", () => {
  const pair = {
    FACTORY_STATE_DIR: "/tmp/state",
    FACTORY_WORKER_URL: "http://127.0.0.1:4100/",
    FACTORY_BUILDER_APP_ROOT: "/srv/builder",
  }

  it("is one worker for every target, with its manifest directory defaulted under its app root", () => {
    expect(loadConfig(pair).builder).toEqual({
      url: "http://127.0.0.1:4100",
      appRoot: "/srv/builder",
      route: DEFAULT_WORKER_ROUTE,
      manifestDir: "/srv/builder/.factory/manifests",
    })
  })

  it("takes an explicit route and manifest directory", () => {
    expect(
      loadConfig({
        ...pair,
        FACTORY_WORKER_ROUTE: "/fix#agent",
        FACTORY_BUILDER_MANIFEST_DIR: "/var/manifests",
      }).builder,
    ).toMatchObject({ route: "/fix#agent", manifestDir: "/var/manifests" })
  })

  it.each([
    [
      "FACTORY_WORKERS",
      '{"cli-flags":{"url":"http://x","appRoot":"/a"}}',
      /FACTORY_WORKERS is retired: one builder serves every target and pin/,
    ],
    [
      "FACTORY_BUILDER_TARGET",
      "/tmp/factory-builder/cli-flags.target.json",
      /FACTORY_BUILDER_TARGET is retired: the builder boots with no target file/,
    ],
  ])("refuses the retired %s by name", (name, value, message) => {
    expect(() => loadConfig({ ...pair, [name]: value })).toThrow(message)
    // Even an empty value: an operator who set it at all learns it does nothing now.
    expect(() => loadConfig({ ...pair, [name]: "" })).toThrow(message)
  })

  it("still needs both halves of the pair", () => {
    const { FACTORY_BUILDER_APP_ROOT: _root, ...urlOnly } = pair
    expect(() => loadConfig(urlOnly)).toThrow(/FACTORY_BUILDER_APP_ROOT is required/)
    const { FACTORY_WORKER_URL: _url, ...rootOnly } = pair
    expect(() => loadConfig(rootOnly)).toThrow(/FACTORY_WORKER_URL is required/)
  })

  it("refuses a drafter app root that is also the builder's", () => {
    const drafter = { FACTORY_DRAFTER_URL: "http://127.0.0.1:4200" }
    expect(() =>
      loadConfig({ ...base, ...drafter, FACTORY_DRAFTER_APP_ROOT: "/tmp/builder/" }),
    ).toThrow(
      "FACTORY_DRAFTER_APP_ROOT is the builder's app root too (/tmp/builder/): the drafter and the builder each need their own",
    )
  })
})

describe("rung 1 configuration", () => {
  it("defaults the export and artifact directories under the state directory", () => {
    const config = loadConfig(base)
    expect(config.exportDir).toBe("/tmp/state/exports")
    expect(config.artifactsDir).toBe("/tmp/state/artifacts")
    expect(config.maxChangedBytes).toBe(1024 * 1024)
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

  it("no longer requires or accepts an outbox, an intake route or an intake task", () => {
    expect(Object.keys(loadConfig(base))).not.toContain("outboxDir")
    // The rung 0 variables are simply ignored rather than rejected, so an old
    // environment keeps working while an operator updates it. So are 3a's intake pair:
    // the drafter's route replaced the intake route, and the drafter app root the task.
    expect(() => loadConfig({ ...base, FACTORY_WORKER_OUTBOX: "/tmp/old" })).not.toThrow()
    expect(() => loadConfig({ ...base, FACTORY_RECEIPT_WAIT_MS: "180000" })).not.toThrow()
    expect(Object.keys(loadConfig(base))).not.toContain("receiptWaitMs")
    const stale = loadConfig({
      ...base,
      FACTORY_INTAKE_ROUTE: "/draft#agent",
      FACTORY_INTAKE_TASK: "devkit-spawn-deadline",
    })
    expect(Object.keys(stale)).not.toContain("intakeRoute")
    expect(Object.keys(stale)).not.toContain("intakeTaskId")
  })

  it("defaults intake attempts to 2, takes a positive integer, and refuses anything else", () => {
    expect(loadConfig(base).maxIntakeAttempts).toBe(2)
    expect(loadConfig({ ...base, FACTORY_MAX_INTAKE_ATTEMPTS: "4" }).maxIntakeAttempts).toBe(4)
    for (const bad of ["0", "-1", "1.5", "two"])
      expect(() => loadConfig({ ...base, FACTORY_MAX_INTAKE_ATTEMPTS: bad })).toThrow(
        /FACTORY_MAX_INTAKE_ATTEMPTS/,
      )
  })

  it("defaults candidate attempts to 2, takes a positive integer, and refuses anything else", () => {
    expect(loadConfig(base).maxCandidateAttempts).toBe(2)
    expect(loadConfig({ ...base, FACTORY_MAX_CANDIDATE_ATTEMPTS: "3" }).maxCandidateAttempts).toBe(
      3,
    )
    for (const bad of ["0", "-1", "1.5", "two"])
      expect(() => loadConfig({ ...base, FACTORY_MAX_CANDIDATE_ATTEMPTS: bad })).toThrow(
        /FACTORY_MAX_CANDIDATE_ATTEMPTS/,
      )
  })

  it("rejects a non-positive byte cap", () => {
    expect(() => loadConfig({ ...base, FACTORY_MAX_CHANGED_BYTES: "0" })).toThrow(
      /FACTORY_MAX_CHANGED_BYTES/,
    )
  })
})

describe("drafter configuration", () => {
  it("leaves the drafter unset and defaults the image to the pinned digest", () => {
    const config = loadConfig(base)
    expect(config.drafter).toBeUndefined()
    // Absent, not present-and-undefined: the runtime spreads this into FactoryOptions under
    // exactOptionalPropertyTypes, so an explicit undefined would be a type error there.
    expect(Object.keys(config)).not.toContain("drafter")
    expect(config.drafterImage).toBe(DRAFTER_IMAGE)
  })

  it("takes the drafter pair, defaulting the route and the manifest directory", () => {
    const config = loadConfig({
      ...base,
      FACTORY_DRAFTER_URL: "http://127.0.0.1:4200/",
      FACTORY_DRAFTER_APP_ROOT: "/srv/drafter",
      FACTORY_DRAFTER_IMAGE: `node:24-slim@sha256:${"b".repeat(64)}`,
    })
    expect(config.drafter).toEqual({
      url: "http://127.0.0.1:4200",
      appRoot: "/srv/drafter",
      route: "/intake#agent",
      manifestDir: "/srv/drafter/.factory/manifests",
    })
    expect(config.drafterImage).toBe(`node:24-slim@sha256:${"b".repeat(64)}`)
    const explicit = loadConfig({
      ...base,
      FACTORY_DRAFTER_URL: "http://127.0.0.1:4200",
      FACTORY_DRAFTER_APP_ROOT: "/srv/drafter",
      FACTORY_DRAFTER_ROUTE: "/draft#agent",
      FACTORY_DRAFTER_MANIFEST_DIR: "/var/lib/factory/manifests",
    })
    expect(explicit.drafter).toMatchObject({
      route: "/draft#agent",
      manifestDir: "/var/lib/factory/manifests",
    })
  })

  it("refuses a drafter knob without the drafter, naming it", () => {
    expect(() => loadConfig({ ...base, FACTORY_DRAFTER_ROUTE: "/draft#agent" })).toThrow(
      "FACTORY_DRAFTER_ROUTE is set but the drafter is not: set FACTORY_DRAFTER_URL and FACTORY_DRAFTER_APP_ROOT, or unset it",
    )
    expect(() => loadConfig({ ...base, FACTORY_DRAFTER_MANIFEST_DIR: "/srv/m" })).toThrow(
      "FACTORY_DRAFTER_MANIFEST_DIR is set but the drafter is not",
    )
    expect(() =>
      loadConfig({
        ...base,
        FACTORY_DRAFTER_IMAGE: `node:24-slim@sha256:${"b".repeat(64)}`,
        FACTORY_DRAFTER_MANIFEST_DIR: "/srv/m",
      }),
    ).toThrow(
      "FACTORY_DRAFTER_MANIFEST_DIR and FACTORY_DRAFTER_IMAGE are set but the drafter is not: set FACTORY_DRAFTER_URL and FACTORY_DRAFTER_APP_ROOT, or unset them",
    )
  })

  it("refuses half a drafter: the URL and the app root come together", () => {
    const bothOrNeither = "FACTORY_DRAFTER_URL and FACTORY_DRAFTER_APP_ROOT: set both or neither"
    expect(() => loadConfig({ ...base, FACTORY_DRAFTER_URL: "http://127.0.0.1:4200" })).toThrow(
      bothOrNeither,
    )
    expect(() => loadConfig({ ...base, FACTORY_DRAFTER_APP_ROOT: "/srv/drafter" })).toThrow(
      bothOrNeither,
    )
  })

  it("rejects a blank or malformed drafter value under its name", () => {
    const pair = {
      ...base,
      FACTORY_DRAFTER_URL: "http://127.0.0.1:4200",
      FACTORY_DRAFTER_APP_ROOT: "/srv/drafter",
    }
    expect(() => loadConfig({ ...pair, FACTORY_DRAFTER_APP_ROOT: "" })).toThrow(
      /FACTORY_DRAFTER_APP_ROOT/,
    )
    expect(() => loadConfig({ ...pair, FACTORY_DRAFTER_URL: "ftp://x" })).toThrow(
      /FACTORY_DRAFTER_URL must be http\(s\)/,
    )
    expect(() => loadConfig({ ...pair, FACTORY_DRAFTER_ROUTE: "" })).toThrow(
      /FACTORY_DRAFTER_ROUTE/,
    )
    expect(() => loadConfig({ ...pair, FACTORY_DRAFTER_MANIFEST_DIR: "" })).toThrow(
      /FACTORY_DRAFTER_MANIFEST_DIR/,
    )
    expect(() => loadConfig({ ...pair, FACTORY_DRAFTER_IMAGE: "" })).toThrow(
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
