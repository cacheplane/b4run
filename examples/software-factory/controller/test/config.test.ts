import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_WORKER_ROUTE, loadConfig } from "../src/lib/config.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

const base = {
  FACTORY_WORKER_URL: "http://127.0.0.1:4100",
  FACTORY_STATE_DIR: "/tmp/state",
  FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
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
    expect(() =>
      loadConfig({ FACTORY_STATE_DIR: "/tmp/state", FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN }),
    ).toThrow(/FACTORY_WORKER_URL is required/)
    expect(() => loadConfig({ ...base, FACTORY_APPROVAL_TTL_MS: "soon" })).toThrow(
      /FACTORY_APPROVAL_TTL_MS/,
    )
    expect(() => loadConfig({ ...base, FACTORY_WORKER_URL: "ftp://x" })).toThrow(
      /FACTORY_WORKER_URL/,
    )
  })

  it("requires FACTORY_WORKER_TOKEN, 32 characters or more, no whitespace", () => {
    const { FACTORY_WORKER_TOKEN: _drop, ...without } = base
    expect(() => loadConfig(without)).toThrow(/FACTORY_WORKER_TOKEN is required/)
    expect(() => loadConfig({ ...base, FACTORY_WORKER_TOKEN: "" })).toThrow(
      /FACTORY_WORKER_TOKEN is required/,
    )
    expect(() => loadConfig({ ...base, FACTORY_WORKER_TOKEN: "short" })).toThrow(/at least 32/)
    expect(() =>
      loadConfig({ ...base, FACTORY_WORKER_TOKEN: `${"a".repeat(20)} ${"b".repeat(20)}` }),
    ).toThrow(/no whitespace/)
    expect(loadConfig(base).workerToken).toBe(TEST_WORKER_TOKEN)
  })

  it("never echoes a refused token", () => {
    const secret = `${"s".repeat(20)} ${"e".repeat(20)}`
    expect(() => loadConfig({ ...base, FACTORY_WORKER_TOKEN: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("sssss") }),
    )
  })
})

describe("the builder endpoint", () => {
  const pair = {
    FACTORY_STATE_DIR: "/tmp/state",
    FACTORY_WORKER_URL: "http://127.0.0.1:4100/",
    FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
  }

  it("is one worker for every target, at its URL alone", () => {
    expect(loadConfig(pair).builder).toEqual({
      url: "http://127.0.0.1:4100",
      route: DEFAULT_WORKER_ROUTE,
    })
  })

  it("takes an explicit route", () => {
    expect(loadConfig({ ...pair, FACTORY_WORKER_ROUTE: "/fix#agent" }).builder).toEqual({
      url: "http://127.0.0.1:4100",
      route: "/fix#agent",
    })
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
    [
      "FACTORY_BUILDER_MANIFEST_DIR",
      "/srv/builder/manifests",
      /FACTORY_BUILDER_MANIFEST_DIR is retired: dispatch stages the workspace over the builder's Agent Protocol port/,
    ],
    [
      "FACTORY_DRAFTER_MANIFEST_DIR",
      "/srv/drafter/manifests",
      /FACTORY_DRAFTER_MANIFEST_DIR is retired: intake stages the workspace over the drafter's Agent Protocol port/,
    ],
  ])("refuses the retired %s by name", (name, value, message) => {
    expect(() => loadConfig({ ...pair, [name]: value })).toThrow(message)
    // Even an empty value: an operator who set it at all learns it does nothing now.
    expect(() => loadConfig({ ...pair, [name]: "" })).toThrow(message)
  })

  it("needs the URL", () => {
    const { FACTORY_WORKER_URL: _url, ...without } = pair
    expect(() => loadConfig(without)).toThrow(/FACTORY_WORKER_URL is required/)
  })

  it("refuses a retired manifest directory even beside a drafter", () => {
    // The drafter pair no longer needs one, and a drafter URL does not make one mean anything.
    expect(() =>
      loadConfig({
        ...pair,
        FACTORY_DRAFTER_URL: "http://127.0.0.1:4200",
        FACTORY_DRAFTER_MANIFEST_DIR: "/m/d",
      }),
    ).toThrow(/FACTORY_DRAFTER_MANIFEST_DIR is retired/)
  })

  for (const name of ["FACTORY_BUILDER_APP_ROOT", "FACTORY_DRAFTER_APP_ROOT"])
    it(`refuses ${name} by name: the controller reads workers over HTTP`, () => {
      expect(() => loadConfig({ ...base, [name]: "/somewhere" })).toThrow(
        new RegExp(`${name} is retired`),
      )
      // Even an empty value: an operator who set it at all learns it does nothing now.
      expect(() => loadConfig({ ...base, [name]: "" })).toThrow(new RegExp(`${name} is retired`))
    })
})

describe("FACTORY_DRAFTER_IMAGE on the controller", () => {
  it("is ignored with one warning, because the drafter sharing the environment still reads it", () => {
    const image = `node:24-slim@sha256:${"b".repeat(64)}`
    const withDrafter = { ...base, FACTORY_DRAFTER_URL: "http://127.0.0.1:4200" }
    for (const env of [base, withDrafter]) {
      const config = loadConfig({ ...env, FACTORY_DRAFTER_IMAGE: image })
      expect(config.warnings).toEqual([
        expect.stringMatching(/^FACTORY_DRAFTER_IMAGE is ignored by the controller/),
      ])
      expect(Object.keys(config)).not.toContain("drafterImage")
    }
    expect(loadConfig(base).warnings).toEqual([])
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
  it("leaves the drafter unset", () => {
    const config = loadConfig(base)
    expect(config.drafter).toBeUndefined()
    // Absent, not present-and-undefined: the runtime spreads this into FactoryOptions under
    // exactOptionalPropertyTypes, so an explicit undefined would be a type error there.
    expect(Object.keys(config)).not.toContain("drafter")
    expect(Object.keys(config)).not.toContain("drafterImage")
  })

  it("needs only a URL per worker", () => {
    const config = loadConfig({ ...base, FACTORY_DRAFTER_URL: "http://127.0.0.1:4200/" })
    expect(config.builder).toEqual({ url: "http://127.0.0.1:4100", route: "/build#agent" })
    expect(config.drafter).toEqual({ url: "http://127.0.0.1:4200", route: "/intake#agent" })
  })

  it("takes an explicit drafter route", () => {
    const explicit = loadConfig({
      ...base,
      FACTORY_DRAFTER_URL: "http://127.0.0.1:4200",
      FACTORY_DRAFTER_ROUTE: "/draft#agent",
    })
    expect(explicit.drafter).toEqual({ url: "http://127.0.0.1:4200", route: "/draft#agent" })
  })

  it("refuses a drafter knob without the drafter, naming it", () => {
    expect(() => loadConfig({ ...base, FACTORY_DRAFTER_ROUTE: "/draft#agent" })).toThrow(
      "FACTORY_DRAFTER_ROUTE is set but the drafter is not: set FACTORY_DRAFTER_URL, or unset it",
    )
  })

  it("rejects a blank or malformed drafter value under its name", () => {
    const pair = { ...base, FACTORY_DRAFTER_URL: "http://127.0.0.1:4200" }
    expect(() => loadConfig({ ...pair, FACTORY_DRAFTER_URL: "ftp://x" })).toThrow(
      /FACTORY_DRAFTER_URL must be http\(s\)/,
    )
    expect(() => loadConfig({ ...pair, FACTORY_DRAFTER_ROUTE: "" })).toThrow(
      /FACTORY_DRAFTER_ROUTE/,
    )
  })

  it("reads the image build limit and timeout, defaulting to one build and thirty minutes", () => {
    const defaults = loadConfig(base)
    expect(defaults.imagesPath).toBe(join(defaults.stateDir, "images.sqlite"))
    expect(defaults.maxImageBuilds).toBe(1)
    expect(defaults.imageBuildTimeoutMs).toBe(1_800_000)
    const set = loadConfig({
      ...base,
      FACTORY_MAX_IMAGE_BUILDS: "2",
      FACTORY_IMAGE_BUILD_TIMEOUT_MS: "2700000",
    })
    expect(set.maxImageBuilds).toBe(2)
    expect(set.imageBuildTimeoutMs).toBe(2_700_000)
    expect(() => loadConfig({ ...base, FACTORY_MAX_IMAGE_BUILDS: "0" })).toThrow(
      /FACTORY_MAX_IMAGE_BUILDS must be a positive integer/,
    )
  })

  it("refuses FACTORY_TARGETS_DIR, which named a copy the prepare script no longer writes", () => {
    expect(() => loadConfig({ ...base, FACTORY_TARGETS_DIR: "/x" })).toThrow(
      /FACTORY_TARGETS_DIR is retired/,
    )
    // Kept (D3): the builder reads it, and whether it is still needed is unverified.
    expect(() => loadConfig({ ...base, FACTORY_SKIP_BASE_PULL: "1" })).not.toThrow()
  })
})
