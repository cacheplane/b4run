import { describe, expect, it } from "vitest"
import { CliError } from "../src/lib/output.ts"
import {
  CLI_EVENT_PROPERTIES,
  commandCompletedEvent,
  devFirstRunCompletedEvent,
  durationBucket,
  errorClass,
  MAX_PROPERTY_LENGTH,
  toAllowedProperties,
} from "../src/lib/signals/events.ts"

const base = { command: "build" as const, cliVersion: "0.14.0", nodeMajor: 24, os: "darwin" }

describe("durationBucket", () => {
  it("buckets by the five boundaries", () => {
    expect(durationBucket(0)).toBe("under_1s")
    expect(durationBucket(999)).toBe("under_1s")
    expect(durationBucket(1000)).toBe("1s_to_10s")
    expect(durationBucket(10_000)).toBe("10s_to_1m")
    expect(durationBucket(60_000)).toBe("1m_to_10m")
    expect(durationBucket(600_000)).toBe("over_10m")
  })
})

describe("errorClass", () => {
  it("reports a B4 error code, an error name, or unknown, never a message", () => {
    expect(errorClass(new CliError("secret path /Users/x", 1, { code: "B4_E1006" }))).toBe(
      "B4_E1006",
    )
    expect(errorClass(new CliError("no code"))).toBe("CliError")
    expect(errorClass(new TypeError("boom /etc/passwd"))).toBe("TypeError")
    class AcmeProjectError extends Error {
      override name = "AcmeProjectError"
    }
    expect(errorClass(new AcmeProjectError("x"))).toBe("Error")
    expect(errorClass("a string")).toBe("unknown")
    expect(errorClass(undefined)).toBe("unknown")
  })
})

describe("commandCompletedEvent", () => {
  it("carries exactly the allowlisted properties for ok", () => {
    const event = commandCompletedEvent({ ...base, outcome: "ok", durationMs: 1500 })
    expect(event.event).toBe("cli:command_completed")
    expect(event.properties).toEqual({
      command: "build",
      cli_version: "0.14.0",
      node_major: 24,
      os: "darwin",
      outcome: "ok",
      duration_bucket: "1s_to_10s",
    })
  })
  it("adds error_class for an error and never the message", () => {
    const event = commandCompletedEvent({
      ...base,
      outcome: "error",
      durationMs: 5,
      error: new RangeError("/home/me/app"),
    })
    expect(event.properties.error_class).toBe("RangeError")
    expect(JSON.stringify(event)).not.toContain("/home/me")
  })
  it("caps every string at 128 characters", () => {
    const event = commandCompletedEvent({
      ...base,
      cliVersion: "9".repeat(300),
      outcome: "ok",
      durationMs: 0,
    })
    expect(event.properties.cli_version).toHaveLength(MAX_PROPERTY_LENGTH)
  })
})

describe("devFirstRunCompletedEvent", () => {
  it("carries only cli_version and route_kind", () => {
    expect(devFirstRunCompletedEvent({ cliVersion: "0.14.0", routeKind: "graph" })).toEqual({
      event: "cli:dev_first_run_completed",
      properties: { cli_version: "0.14.0", route_kind: "graph" },
    })
  })
})

describe("toAllowedProperties", () => {
  it("drops unknown keys and non-scalar values", () => {
    expect(
      toAllowedProperties("cli:dev_first_run_completed", {
        route_kind: "agent",
        prompt: "secret",
        path: "/x",
        messages: [],
        cli_version: { v: 1 },
        nested: { a: 1 },
      }),
    ).toEqual({ route_kind: "agent" })
  })
  it("never allowlists a forbidden name", () => {
    for (const keys of Object.values(CLI_EVENT_PROPERTIES)) {
      for (const forbidden of [
        "email",
        "path",
        "prompt",
        "messages",
        "error",
        "threadId",
        "runId",
        "query",
        "text",
      ]) {
        expect(keys).not.toContain(forbidden)
      }
    }
  })
})
