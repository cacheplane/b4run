import { describe, expect, it } from "vitest"
import { SIGNAL_EVENTS } from "../../apps/web/app/lib/analytics/events.ts"
import { EVENT_CONTRACT, FORBIDDEN_PROPERTIES } from "./contract.ts"

describe("EVENT_CONTRACT", () => {
  it("covers exactly $pageview plus the signal events the site emits", () => {
    const keys = Object.keys(EVENT_CONTRACT).filter(
      (key) => key !== "$pageview" && !key.startsWith("cli:"),
    )
    expect([...keys].sort()).toEqual(Object.values(SIGNAL_EVENTS).sort())
    expect(EVENT_CONTRACT.$pageview).toBeDefined()
  })

  it("pins the two CLI events to the spec's properties", () => {
    expect(EVENT_CONTRACT["cli:command_completed"]).toEqual({
      requiredProperties: [
        "command",
        "cli_version",
        "node_major",
        "os",
        "outcome",
        "duration_bucket",
      ],
      allowedProperties: [
        "command",
        "cli_version",
        "node_major",
        "os",
        "outcome",
        "duration_bucket",
        "error_class",
      ],
      allowedBreakdowns: [
        "command",
        "outcome",
        "os",
        "node_major",
        "cli_version",
        "duration_bucket",
        "error_class",
      ],
    })
    expect(EVENT_CONTRACT["cli:dev_first_run_completed"]).toEqual({
      requiredProperties: ["cli_version", "route_kind"],
      allowedProperties: ["cli_version", "route_kind"],
      allowedBreakdowns: ["cli_version", "route_kind"],
    })
  })

  it("never allows a forbidden property", () => {
    for (const [event, contract] of Object.entries(EVENT_CONTRACT)) {
      for (const property of contract.allowedProperties) {
        expect(FORBIDDEN_PROPERTIES as readonly string[], `${event}.${property}`).not.toContain(
          property,
        )
      }
    }
  })

  it("keeps required properties and breakdowns inside the allowed set", () => {
    for (const [event, contract] of Object.entries(EVENT_CONTRACT)) {
      for (const property of [...contract.requiredProperties, ...contract.allowedBreakdowns]) {
        expect(contract.allowedProperties, `${event}.${property}`).toContain(property)
      }
    }
  })
})
