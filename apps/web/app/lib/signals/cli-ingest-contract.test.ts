import { describe, expect, it } from "vitest"
import { REPORTING_COMMANDS } from "../../../../../packages/cli/src/lib/signals/env"
import {
  CLI_EVENT_PROPERTIES,
  durationBucket,
  MAX_PROPERTY_LENGTH,
} from "../../../../../packages/cli/src/lib/signals/events"
import { EVENT_CONTRACT } from "../../../../../scripts/posthog/contract"
import { CLI_INGEST_MAX_STRING_LENGTH, CLI_SIGNAL_RULES } from "./cli-ingest"

// The CLI shapes these events and the dashboards read them; the ingest route
// must accept exactly what the CLI sends and what the PostHog contract expects.
describe("CLI ingest rules match the CLI and the PostHog contract", () => {
  it("covers the same two events as the CLI", () => {
    expect(Object.keys(CLI_SIGNAL_RULES).sort()).toEqual(Object.keys(CLI_EVENT_PROPERTIES).sort())
  })

  it("allows exactly the CLI's property names for each event", () => {
    for (const [event, properties] of Object.entries(CLI_EVENT_PROPERTIES)) {
      const rules = CLI_SIGNAL_RULES[event as keyof typeof CLI_SIGNAL_RULES]
      expect(Object.keys(rules).sort(), event).toEqual([...properties].sort())
    }
  })

  it("requires exactly the PostHog contract's required properties", () => {
    for (const [event, rules] of Object.entries(CLI_SIGNAL_RULES)) {
      const required = Object.entries(rules)
        .filter(([, rule]) => rule.required)
        .map(([name]) => name)
      expect(required.sort(), event).toEqual(
        [...(EVENT_CONTRACT[event]?.requiredProperties ?? [])].sort(),
      )
    }
  })

  it("accepts every command the CLI reports and nothing else", () => {
    const rule = CLI_SIGNAL_RULES["cli:command_completed"].command
    expect(rule.type === "string" ? [...(rule.values ?? [])].sort() : []).toEqual(
      [...REPORTING_COMMANDS].sort(),
    )
  })

  it("accepts every duration bucket the CLI produces", () => {
    const rule = CLI_SIGNAL_RULES["cli:command_completed"].duration_bucket
    const produced = [0, 1_000, 10_000, 60_000, 600_000].map(durationBucket)
    expect(rule.type === "string" ? [...(rule.values ?? [])].sort() : []).toEqual(
      [...new Set(produced)].sort(),
    )
  })

  it("caps strings at the CLI's own limit", () => {
    expect(CLI_INGEST_MAX_STRING_LENGTH).toBe(MAX_PROPERTY_LENGTH)
  })
})
