import { describe, expect, it } from "vitest"
import { SIGNAL_EVENTS } from "../../apps/web/app/lib/analytics/events.ts"
import { EVENT_CONTRACT, FORBIDDEN_PROPERTIES } from "./contract.ts"

describe("EVENT_CONTRACT", () => {
  it("covers exactly $pageview plus the signal events the site emits", () => {
    const keys = Object.keys(EVENT_CONTRACT).filter((key) => key !== "$pageview")
    expect([...keys].sort()).toEqual(Object.values(SIGNAL_EVENTS).sort())
    expect(EVENT_CONTRACT.$pageview).toBeDefined()
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
