import axe from "axe-core"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { APPROVAL_FIXTURES, TURN_FIXTURES } from "../fixtures/activity-fixtures.ts"
import { expandAll } from "../fixtures/contract-serializer.ts"
import { button, click, mountApproval, mountTurn, settle } from "./render.js"

/** Serious and critical axe violations under `root`, as "rule: target" lines. */
async function violations(root: HTMLElement): Promise<string[]> {
  vi.useRealTimers() // axe schedules its own work on timers
  const result = await axe.run(root, {
    // jsdom has no layout, so contrast is checked in the browser lanes instead.
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  })
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) => v.nodes.map((node) => `${v.id}: ${node.target.join(" ")}`))
}

describe("accessibility (axe): no serious or critical violation in any fixture", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  for (const [name, fixture] of Object.entries(TURN_FIXTURES)) {
    test(`turn: ${name}, as mounted and fully expanded`, async () => {
      const mounted = mountTurn(fixture)
      const root = mounted.nativeElement as HTMLElement
      expect(await violations(root)).toEqual([])
      vi.useFakeTimers()
      await expandAll(root, (target) => click(mounted, target))
      expect(await violations(root)).toEqual([])
    })
  }

  for (const [name, fixture] of Object.entries(APPROVAL_FIXTURES)) {
    test(`approval: ${name}`, async () => {
      const outcome = fixture.decide?.outcome
      const mounted = mountApproval(fixture, () =>
        outcome === "reject" ? Promise.reject(new Error("network down")) : new Promise(() => {}),
      )
      const root = mounted.nativeElement as HTMLElement
      if (fixture.decide) {
        const label = { once: "Allow once", always: "Always allow", deny: "Deny" }[
          fixture.decide.choice
        ]
        click(mounted, button(root, label))
        await settle(mounted)
      }
      expect(await violations(root)).toEqual([])
    })
  }

  test("the check itself bites: a custom element between a list and its item is a violation", async () => {
    const list = document.createElement("ol")
    list.innerHTML = '<b4-step style="display: contents"><li>row</li></b4-step>'
    document.body.append(list)
    try {
      expect(await violations(list)).toContain("list: ol")
    } finally {
      list.remove()
    }
  })

  test("disclosures are keyboard-operable buttons: Enter on a focused summary toggles it", () => {
    const fixture = TURN_FIXTURES["done research turn"]
    if (!fixture) throw new Error("missing fixture")
    const mounted = mountTurn(fixture)
    const summary = (mounted.nativeElement as HTMLElement).querySelector(
      "button.b4-turn__summary",
    ) as HTMLButtonElement
    expect(summary.type).toBe("button")
    summary.focus()
    expect(document.activeElement).toBe(summary)
    // A native button turns Enter and Space into a click; jsdom does not
    // synthesize that, so dispatch the click the browser would.
    summary.click()
    mounted.detectChanges()
    expect(summary.getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(summary) // focus never moves on its own
  })
})
