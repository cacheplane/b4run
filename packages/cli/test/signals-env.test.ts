import { describe, expect, it } from "vitest"
import {
  CI_ENVIRONMENT_VARIABLES,
  isEnvFlagSet,
  isReportingCommand,
  REPORTING_COMMANDS,
  signalsDisabledReason,
} from "../src/lib/signals/env.ts"

describe("reporting commands", () => {
  it("lists exactly the seven development-time commands", () => {
    expect([...REPORTING_COMMANDS]).toEqual([
      "dev",
      "build",
      "add",
      "check",
      "typegen",
      "verify",
      "eval",
    ])
  })
  it("never includes start or the dev child", () => {
    for (const name of ["start", "__dev-child", "run", "test", "docs", "routes"]) {
      expect(isReportingCommand(name), name).toBe(false)
    }
    expect(isReportingCommand("dev")).toBe(true)
  })
})

describe("signalsDisabledReason", () => {
  it("is null for an empty environment", () => {
    expect(signalsDisabledReason({})).toBeNull()
  })
  it("honours B4_TELEMETRY_DISABLED before anything else", () => {
    expect(signalsDisabledReason({ B4_TELEMETRY_DISABLED: "1", CI: "true" })).toBe("opt-out")
  })
  it("honours DO_NOT_TRACK", () => {
    expect(signalsDisabledReason({ DO_NOT_TRACK: "1" })).toBe("dnt")
  })
  it("treats every CI variable as inert", () => {
    for (const name of CI_ENVIRONMENT_VARIABLES) {
      expect(signalsDisabledReason({ [name]: "true" }), name).toBe("ci")
    }
    expect(CI_ENVIRONMENT_VARIABLES).toContain("GITHUB_ACTIONS")
    expect(CI_ENVIRONMENT_VARIABLES).toContain("BUILDKITE")
    expect(CI_ENVIRONMENT_VARIABLES).toContain("CIRCLECI")
  })
  it("ignores a flag set to 0, false, or empty", () => {
    expect(
      signalsDisabledReason({ B4_TELEMETRY_DISABLED: "0", DO_NOT_TRACK: "", CI: "false" }),
    ).toBeNull()
    expect(isEnvFlagSet("FALSE")).toBe(false)
    expect(isEnvFlagSet("yes")).toBe(true)
  })
})
