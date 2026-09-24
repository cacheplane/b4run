import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DRAFTER_IMAGE, loadConfig, workerEndpointFor } from "../src/lib/config.ts"
import { writeTargetFile } from "./builder-target-file.ts"
import { shippedPin } from "./temp-repo.ts"

const targets = mkdtempSync(join(tmpdir(), "factory-config-targets-"))
const cliFlagsTarget = writeTargetFile(targets, "cli-flags")

const base = {
  FACTORY_WORKER_URL: "http://127.0.0.1:4100",
  FACTORY_STATE_DIR: "/tmp/state",
  FACTORY_BUILDER_APP_ROOT: "/tmp/builder",
  FACTORY_BUILDER_TARGET: cliFlagsTarget,
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base)
    expect(config.approvalTtlMs).toBe(900_000)
    expect(config.maxActiveMs).toBe(1_200_000)
    expect(config.registryPath).toBe("/tmp/state/registry.sqlite")
    // The legacy pair is ONE entry, keyed by the target its builder's target file names, on
    // the default route.
    expect(config.workers).toEqual({
      "cli-flags": {
        url: "http://127.0.0.1:4100",
        appRoot: "/tmp/builder",
        route: "/build#agent",
        // The builder's FACTORY_BUILDER_MANIFEST_DIR default, under its app root.
        manifestDir: "/tmp/builder/.factory/manifests",
        // Read from the target file the builder boots from: the pin it runs at.
        pin: shippedPin("cli-flags"),
      },
    })
  })

  it("reads the legacy builder's pin from its target file", () => {
    const pinned = writeTargetFile(join(targets, "pinned"), "devkit", "e".repeat(40))
    expect(loadConfig({ ...base, FACTORY_BUILDER_TARGET: pinned }).workers.devkit?.pin).toBe(
      "e".repeat(40),
    )
  })

  it("rejects missing or malformed values", () => {
    expect(() => loadConfig({})).toThrow(/FACTORY_STATE_DIR is required/)
    expect(() => loadConfig({ FACTORY_STATE_DIR: "/tmp/state" })).toThrow(
      /FACTORY_WORKERS or FACTORY_WORKER_URL is required/,
    )
    expect(() => loadConfig({ ...base, FACTORY_APPROVAL_TTL_MS: "soon" })).toThrow(
      /FACTORY_APPROVAL_TTL_MS/,
    )
    expect(() => loadConfig({ ...base, FACTORY_WORKER_URL: "ftp://x" })).toThrow(
      /FACTORY_WORKER_URL/,
    )
    const { FACTORY_BUILDER_APP_ROOT: _omitted, ...withoutBuilderRoot } = base
    expect(() => loadConfig(withoutBuilderRoot)).toThrow(/FACTORY_BUILDER_APP_ROOT is required/)
    const { FACTORY_WORKER_URL: _url, ...withoutUrl } = base
    expect(() => loadConfig(withoutUrl)).toThrow(/FACTORY_WORKER_URL is required/)
  })
})

describe("the legacy pair's target", () => {
  it("is required: the controller must know which target the one builder serves", () => {
    const { FACTORY_BUILDER_TARGET: _omitted, ...without } = base
    expect(() => loadConfig(without)).toThrow(
      /FACTORY_BUILDER_TARGET is required with FACTORY_WORKER_URL/,
    )
  })

  it("is read from the builder's own target file, and refused by name when it cannot be", () => {
    expect(
      Object.keys(
        loadConfig({ ...base, FACTORY_BUILDER_TARGET: writeTargetFile(targets, "devkit") }).workers,
      ),
    ).toEqual(["devkit"])
    expect(() =>
      loadConfig({ ...base, FACTORY_BUILDER_TARGET: join(targets, "absent.json") }),
    ).toThrow(/FACTORY_BUILDER_TARGET could not be read/)
    const garbled = join(targets, "garbled.json")
    writeFileSync(garbled, JSON.stringify({ version: 1, target: { id: "cli-flags" } }))
    expect(() => loadConfig({ ...base, FACTORY_BUILDER_TARGET: garbled })).toThrow(
      /FACTORY_BUILDER_TARGET is not a builder target file/,
    )
  })

  it("routes no other target to that builder", () => {
    const { workers } = loadConfig(base)
    expect(workerEndpointFor(workers, "cli-flags")?.url).toBe("http://127.0.0.1:4100")
    // No wildcard: a work order of another target has no worker, and `dispatch` refuses it
    // before spending anything, rather than burning it on a builder that would refuse it.
    expect(workerEndpointFor(workers, "devkit")).toBeUndefined()
    expect(workerEndpointFor(workers, "*")).toBeUndefined()
    expect(workerEndpointFor(workers, "constructor")).toBeUndefined()
  })
})

describe("the worker map", () => {
  const workers = JSON.stringify({
    devkit: { url: "http://127.0.0.1:4101/", appRoot: "/srv/devkit-builder" },
    "cli-flags": {
      url: "http://127.0.0.1:4102",
      appRoot: "/srv/cli-builder",
      route: "/repair#agent",
    },
  })
  const mapped = { FACTORY_STATE_DIR: "/tmp/state", FACTORY_WORKERS: workers }

  it("parses FACTORY_WORKERS into one entry per target, route defaulted, url trimmed", () => {
    const config = loadConfig(mapped)
    expect(config.workers).toEqual({
      devkit: {
        url: "http://127.0.0.1:4101",
        appRoot: "/srv/devkit-builder",
        route: "/build#agent",
        manifestDir: "/srv/devkit-builder/.factory/manifests",
      },
      "cli-flags": {
        url: "http://127.0.0.1:4102",
        appRoot: "/srv/cli-builder",
        route: "/repair#agent",
        manifestDir: "/srv/cli-builder/.factory/manifests",
      },
    })
    expect(workerEndpointFor(config.workers, "devkit")?.appRoot).toBe("/srv/devkit-builder")
    // A target with no entry has no worker.
    expect(workerEndpointFor(config.workers, "testing")).toBeUndefined()
  })

  it("accepts a pin on a FACTORY_WORKERS entry, and refuses one that is not a full sha", () => {
    const entry = { url: "http://127.0.0.1:4101", appRoot: "/srv/devkit-builder" }
    expect(
      loadConfig({
        FACTORY_STATE_DIR: "/tmp/state",
        FACTORY_WORKERS: JSON.stringify({ devkit: { ...entry, pin: "f".repeat(40) } }),
      }).workers.devkit?.pin,
    ).toBe("f".repeat(40))
    expect(() =>
      loadConfig({
        FACTORY_STATE_DIR: "/tmp/state",
        FACTORY_WORKERS: JSON.stringify({ devkit: { ...entry, pin: "abc" } }),
      }),
    ).toThrow(/full lowercase commit sha/)
  })

  it("keys entries by target id alone: the wildcard is gone", () => {
    // A builder process serves one target, so an entry matching several would route work
    // orders to a builder that refuses them at admission.
    expect(() =>
      loadConfig({
        ...mapped,
        FACTORY_WORKERS: JSON.stringify({ "*": { url: "http://127.0.0.1:4100", appRoot: "/a" } }),
      }),
    ).toThrow(
      'FACTORY_WORKERS: "*" is not a target id: each entry is keyed by the one target its builder serves',
    )
  })

  it("rejects a malformed FACTORY_WORKERS under the variable's name", () => {
    expect(() => loadConfig({ ...mapped, FACTORY_WORKERS: "{not json" })).toThrow(
      /FACTORY_WORKERS is not JSON/,
    )
    expect(() => loadConfig({ ...mapped, FACTORY_WORKERS: "{}" })).toThrow(
      /FACTORY_WORKERS names no worker/,
    )
    expect(() =>
      loadConfig({
        ...mapped,
        FACTORY_WORKERS: JSON.stringify({ devkit: { url: "ftp://x", appRoot: "/srv" } }),
      }),
    ).toThrow(/FACTORY_WORKERS: devkit.url: url must be http\(s\)/)
    expect(() =>
      loadConfig({
        ...mapped,
        FACTORY_WORKERS: JSON.stringify({ devkit: { url: "http://x", appRoot: "" } }),
      }),
    ).toThrow(/FACTORY_WORKERS: devkit.appRoot/)
    expect(() =>
      loadConfig({
        ...mapped,
        FACTORY_WORKERS: JSON.stringify({ devkit: { url: "http://x", appRoot: "/srv", extra: 1 } }),
      }),
    ).toThrow(/FACTORY_WORKERS: devkit/)
  })

  it("refuses two targets on one builder process", () => {
    expect(() =>
      loadConfig({
        ...mapped,
        FACTORY_WORKERS: JSON.stringify({
          devkit: { url: "http://127.0.0.1:4101", appRoot: "/srv/a" },
          cli: { url: "http://127.0.0.1:4101/", appRoot: "/srv/a" },
        }),
      }),
    ).toThrow(
      "FACTORY_WORKERS: workers devkit and cli share http://127.0.0.1:4101, but a builder process serves one target: run one process per target",
    )
  })

  it("refuses two builder processes over one app root", () => {
    // Two processes over one `.b4/workspaces` store would each take the other's threads for
    // their own; each builder process is its own copy of the package.
    expect(() =>
      loadConfig({
        ...mapped,
        FACTORY_WORKERS: JSON.stringify({
          devkit: { url: "http://127.0.0.1:4101", appRoot: "/srv/builder" },
          cli: { url: "http://127.0.0.1:4102", appRoot: "/srv/builder/" },
        }),
      }),
    ).toThrow(
      "FACTORY_WORKERS: workers devkit and cli share the app root /srv/builder/: give each builder process its own copy of the package",
    )
  })

  it("refuses the map beside any legacy knob, naming the one that was set", () => {
    expect(() => loadConfig({ ...base, FACTORY_WORKERS: workers })).toThrow(
      "FACTORY_WORKERS is set; unset FACTORY_WORKER_URL and FACTORY_BUILDER_APP_ROOT and FACTORY_BUILDER_TARGET",
    )
    expect(() => loadConfig({ ...mapped, FACTORY_BUILDER_APP_ROOT: "/tmp/builder" })).toThrow(
      "FACTORY_WORKERS is set; unset FACTORY_BUILDER_APP_ROOT",
    )
    // The legacy route has nowhere to go: each entry carries its own.
    expect(() => loadConfig({ ...mapped, FACTORY_WORKER_ROUTE: "/fix#agent" })).toThrow(
      "FACTORY_WORKERS is set; unset FACTORY_WORKER_ROUTE",
    )
    // Nor the legacy target: each entry's key is its target.
    expect(() => loadConfig({ ...mapped, FACTORY_BUILDER_TARGET: cliFlagsTarget })).toThrow(
      "FACTORY_WORKERS is set; unset FACTORY_BUILDER_TARGET",
    )
  })

  it("takes each entry's manifest directory, or its app root's default", () => {
    const config = loadConfig({
      ...mapped,
      FACTORY_WORKERS: JSON.stringify({
        devkit: { url: "http://127.0.0.1:4101", appRoot: "/srv/a", manifestDir: "/var/m/devkit" },
        cli: { url: "http://127.0.0.1:4102", appRoot: "/srv/b" },
      }),
    })
    expect(config.workers.devkit?.manifestDir).toBe("/var/m/devkit")
    expect(config.workers.cli?.manifestDir).toBe("/srv/b/.factory/manifests")
    expect(() =>
      loadConfig({
        ...mapped,
        FACTORY_WORKERS: JSON.stringify({
          devkit: { url: "http://x", appRoot: "/a", manifestDir: "" },
        }),
      }),
    ).toThrow(/FACTORY_WORKERS: devkit.manifestDir/)
  })

  it("takes FACTORY_BUILDER_MANIFEST_DIR into the legacy entry, and refuses it beside the map", () => {
    expect(
      loadConfig({ ...base, FACTORY_BUILDER_MANIFEST_DIR: "/var/manifests" }).workers["cli-flags"]
        ?.manifestDir,
    ).toBe("/var/manifests")
    // The map's entries carry their own: a process-wide one would name nobody's directory.
    expect(() => loadConfig({ ...mapped, FACTORY_BUILDER_MANIFEST_DIR: "/var/manifests" })).toThrow(
      "FACTORY_WORKERS is set; unset FACTORY_BUILDER_MANIFEST_DIR",
    )
  })

  it("takes the legacy route into the legacy entry", () => {
    expect(
      loadConfig({ ...base, FACTORY_WORKER_ROUTE: "/fix#agent" }).workers["cli-flags"]?.route,
    ).toBe("/fix#agent")
  })

  it("refuses a drafter app root that is also a builder's", () => {
    const drafter = { FACTORY_DRAFTER_URL: "http://127.0.0.1:4200" }
    expect(() =>
      loadConfig({ ...base, ...drafter, FACTORY_DRAFTER_APP_ROOT: "/tmp/builder/" }),
    ).toThrow(
      "FACTORY_DRAFTER_APP_ROOT is worker cli-flags's app root too (/tmp/builder/): the drafter and every builder each need their own",
    )
    expect(() =>
      loadConfig({ ...mapped, ...drafter, FACTORY_DRAFTER_APP_ROOT: "/srv/cli-builder" }),
    ).toThrow(/FACTORY_DRAFTER_APP_ROOT is worker cli-flags's app root too/)
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
