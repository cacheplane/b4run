import { describe, expect, it, vi } from "vitest"
import type { PosthogClient } from "./client.ts"
import { DEFAULT_COVERAGE, evaluateEvents, fetchRecentEvents, type LiveEvent } from "./quality.ts"

const at = "2026-10-21T00:00:00Z"
const pageview: LiveEvent = { event: "$pageview", timestamp: at, properties: {} }
const evaluate = (events: LiveEvent[]) => evaluateEvents([pageview, ...events], DEFAULT_COVERAGE)

describe("evaluateEvents", () => {
  it("reports a missing required property as an error", () => {
    const findings = evaluate([
      { event: "site:cta_click", timestamp: at, properties: { surface: "home" } },
    ])
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        kind: "missing_required_property",
        property: "cta_id",
      }),
    ])
  })

  it("reports a forbidden property as an error", () => {
    const findings = evaluate([
      {
        event: "site:install_command_copied",
        timestamp: at,
        properties: { surface: "home", email: "a@b.c" },
      },
    ])
    expect(findings).toEqual([
      expect.objectContaining({ severity: "error", kind: "forbidden_property", property: "email" }),
    ])
  })

  it("reports an unknown property as a warning", () => {
    const findings = evaluate([
      {
        event: "site:install_command_copied",
        timestamp: at,
        properties: { surface: "home", mystery: 1 },
      },
    ])
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        kind: "unexpected_property",
        property: "mystery",
      }),
    ])
  })

  it("reports a label longer than 128 characters as an error", () => {
    const findings = evaluate([
      {
        event: "site:cta_click",
        timestamp: at,
        properties: { cta_id: "x".repeat(129), surface: "home" },
      },
    ])
    expect(findings).toEqual([
      expect.objectContaining({ severity: "error", kind: "label_too_long", property: "cta_id" }),
    ])
  })

  it("accepts a label of exactly 128 characters", () => {
    expect(
      evaluate([
        {
          event: "site:cta_click",
          timestamp: at,
          properties: { cta_id: "x".repeat(128), surface: "home" },
        },
      ]),
    ).toEqual([])
  })

  it("ignores PostHog's own properties", () => {
    const findings = evaluate([
      {
        event: "site:install_command_copied",
        timestamp: at,
        properties: { surface: "home", $current_url: "https://b4.run", utm_source: "x" },
      },
    ])
    expect(findings).toEqual([])
  })

  it("requires pageview coverage", () => {
    const findings = evaluateEvents([], DEFAULT_COVERAGE)
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        kind: "insufficient_event_coverage",
        event: "$pageview",
      }),
    ])
  })
})

describe("fetchRecentEvents", () => {
  it("queries each event name and concatenates the results", async () => {
    const get = vi.fn(async (_path: string, query?: Record<string, string>) => ({
      results: [{ event: query?.event, timestamp: at, properties: {} }],
    }))
    const client = { get } as unknown as PosthogClient
    const events = await fetchRecentEvents(client, {
      eventNames: ["a", "b"],
      after: "2026-10-14T00:00:00.000Z",
      limitPerEvent: 25,
    })
    expect(events.map((e) => e.event)).toEqual(["a", "b"])
    expect(get).toHaveBeenCalledWith("events/", {
      event: "a",
      after: "2026-10-14T00:00:00.000Z",
      limit: "25",
    })
  })
})
