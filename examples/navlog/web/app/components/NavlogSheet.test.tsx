// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import type { NavlogSheetProps } from "./NavlogSheet"

// pretable needs layout; the grid is a stand-in here (its own tests cover it,
// and the real grid is checked in the browser).
vi.mock("./NavlogGrid", () => ({
  NavlogGrid: () => <div data-testid="pretable" />,
}))

const { NavlogSheet } = await import("./NavlogSheet")

const props = (overrides: Partial<NavlogSheetProps> = {}): NavlogSheetProps => ({
  navlog: SAMPLE_NAVLOG,
  planningAnswer: "VFR all the way.",
  open: true,
  onToggle: () => {},
  tab: "legs",
  onTabChange: () => {},
  ...overrides,
})

const render = (overrides: Partial<NavlogSheetProps> = {}): string =>
  renderToStaticMarkup(<NavlogSheet {...props(overrides)} />)

function mountSheet(overrides: Partial<NavlogSheetProps> = {}) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<NavlogSheet {...props(overrides)} />))
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

const BODY_HIDDEN = /class="wb-sheet-body[^"]*hidden print:block"/

describe("NavlogSheet", () => {
  test("collapsed shows the totals line and the actions", () => {
    const html = render({ open: false })
    expect(html).toContain("KSTP → KRST")
    expect(html).toContain("66 nm")
    expect(html).toContain("0:33")
    expect(html).toContain("5.5 gal")
    expect(html).toContain("6:20 reserve")
    expect(html).toContain("Print")
    expect(html).toContain("Copy FPL")
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain("Show navlog")
    expect(html).not.toContain('role="tablist"')
  })
  test("collapsed keeps the body in the DOM, hidden on screen but printed", () => {
    const html = render({ open: false, planningAnswer: "" })
    expect(html).toContain("<table")
    expect(html).toMatch(BODY_HIDDEN)
  })
  test("open holds the print table, the flight plan and the brief", () => {
    const html = render()
    expect(html).toContain("<table")
    expect(html).toContain("7 Aircraft ID")
    expect(html).toContain("VFR all the way.")
    expect(html).not.toMatch(BODY_HIDDEN)
  })
  test("warns when the reserve is short", () => {
    const thirsty = {
      ...SAMPLE_NAVLOG,
      totals: { ...SAMPLE_NAVLOG.totals, reserveOk: false, reserveMin: 20 },
    }
    expect(render({ navlog: thirsty, planningAnswer: "", open: false })).toContain(
      "Reserve under 45 min",
    )
  })
  test("is a disclosure with aria-expanded", () => {
    const html = render({ planningAnswer: "" })
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain("Hide navlog")
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1]
    expect(controls).toBeDefined()
    expect(html).toContain(`id="${controls}"`)
  })
  test("on the phone tab the totals are plain text, not a toggle", () => {
    const html = render({ planningAnswer: "", variant: "cards", collapsible: false })
    expect(html).not.toContain("aria-expanded")
    expect(html).toContain("66 nm")
    expect(html).not.toMatch(BODY_HIDDEN)
  })
})

describe("navlog sheet: strip and tabs", () => {
  test("a verdict strip region, then Legs · Weather · Totals & plan · Brief with Legs selected", () => {
    const html = render({ planningAnswer: "Bottom line: GO — VFR all the way." })
    expect(html).toMatch(/<section aria-label="Verdict summary"[^>]*wb-verdict-strip/)
    expect(html).toContain('role="tablist"')
    expect(html).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>Legs</)
    const labels = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((match) => match[1])
    expect(labels).toEqual(["Legs", "Weather", "Totals &amp; plan", "Brief"])
  })
  test("the Weather tab holds the brief by route role, the stations en route", () => {
    const weatherBrief = {
      airports: [
        {
          id: "KRST",
          now: "VFR" as const,
          atEta: "MVFR" as const,
          line: "VFR now, MVFR at ETA",
          metar: "METAR KRST 061354Z 31015KT 10SM BKN045 06/M03 A3010",
          taf: "TAF KRST 061130Z 0612/0712 31015KT P6SM BKN025",
        },
      ],
      winds: [],
      advisories: [],
      note: "",
    }
    const stations = [
      { id: "KOWA", name: "Owatonna", lat: 44.1, lon: -93.3, alongNm: 40, offsetNm: 6 },
    ]
    const html = render({ tab: "weather", weatherBrief, stations })
    const panel = html.slice(html.search(/role="tabpanel"[^>]*id="[^"]*-weather"/))
    expect(html).toMatch(/role="tabpanel"[^>]*id="[^"]*-weather"(?![^>]*hidden)[^>]*>/)
    expect(panel).toContain(">Origin</h3>")
    expect(panel).toContain("40 nm along")
    expect(panel).toContain("KRST 061354Z")
  })
  test("the Weather panel sits after Legs, so it prints after the legs", () => {
    const html = render()
    const order = [...html.matchAll(/role="tabpanel"[^>]*id="[^"]*-(\w+)"/g)].map((m) => m[1])
    expect(order).toEqual(["legs", "weather", "plan", "brief"])
    expect(html).toMatch(/role="tabpanel"[^>]*id="[^"]*-weather"[^>]*hidden=""/)
    expect(html).toContain("No weather brief yet.")
  })
  test("the strip's reason selects the Brief tab", () => {
    const onTabChange = vi.fn()
    const view = mountSheet({ planningAnswer: "Bottom line: GO — VFR all the way.", onTabChange })
    act(() => {
      view.container.querySelector<HTMLButtonElement>(".wb-verdict-strip button")?.click()
    })
    expect(onTabChange).toHaveBeenCalledWith("brief")
    view.unmount()
  })
  test("the strip's reason controls the Brief panel and says it opens it", () => {
    const view = mountSheet({ planningAnswer: "Bottom line: GO — VFR all the way." })
    const button = view.container.querySelector<HTMLButtonElement>(".wb-verdict-strip button")
    const panel = document.getElementById(button?.getAttribute("aria-controls") ?? "")
    expect(panel?.getAttribute("role")).toBe("tabpanel")
    expect(panel?.id).toMatch(/-brief$/)
    expect(button?.querySelector(".sr-only")?.textContent).toBe(" (opens the brief)")
    view.unmount()
  })
  test("Legs: the grid, the totals strip, and a print-only table with every leg", () => {
    const html = render({ variant: "table" })
    expect(html).toContain('data-testid="pretable"')
    expect(html).toMatch(/aria-label="Leg totals"/)
    expect(html).toMatch(/<div class="hidden print:block"><div><table/)
    for (const leg of SAMPLE_NAVLOG.legs) expect(html).toContain(`${leg.from} → ${leg.to}`)
  })
  test("the totals tiles live on Totals & plan, labelled apart from the strip", () => {
    const html = render({ tab: "plan" })
    expect(html).toMatch(
      /role="tabpanel"[^>]*id="[^"]*-plan"[^>]*>(?:(?!role="tabpanel").)*aria-label="Totals"/,
    )
    expect(html).toMatch(/role="tabpanel"[^>]*id="[^"]*-plan"(?![^>]*hidden)[^>]*>/)
  })
  test("the reserve warning shows in the totals strip", () => {
    const short = { ...SAMPLE_NAVLOG, totals: { ...SAMPLE_NAVLOG.totals, reserveOk: false } }
    const html = render({ navlog: short })
    expect(html).toMatch(/aria-label="Leg totals"(?:(?!<\/dl>).)*under 45 min/)
  })
  test("phones keep the cards on Legs, with no grid", () => {
    const html = render({ variant: "cards", collapsible: false })
    expect(html).not.toContain('data-testid="pretable"')
    expect(html).toContain("wb-leg-card")
    expect(html).toContain('role="tablist"')
  })
  test("inactive panels stay mounted but hidden, and print", () => {
    const html = render({ tab: "brief" })
    expect(html).toMatch(/role="tabpanel"[^>]*id="[^"]*-legs"[^>]*hidden=""/)
    expect(html).toMatch(/role="tabpanel"[^>]*id="[^"]*-weather"[^>]*hidden=""/)
    expect(html).toMatch(/role="tabpanel"[^>]*id="[^"]*-plan"[^>]*hidden=""/)
    expect(html).not.toMatch(/role="tabpanel"[^>]*id="[^"]*-brief"[^>]*hidden=""/)
    expect(html).toContain("7 Aircraft ID")
  })
  test("the full verdict card is on the Brief tab only", () => {
    const html = render({ tab: "brief", planningAnswer: "Bottom line: GO — VFR all the way." })
    expect(html).toMatch(
      /role="tabpanel"[^>]*id="[^"]*-brief"[^>]*>(?:(?!role="tabpanel").)*class="wb-verdict"/,
    )
    expect(html.split('class="wb-verdict"').length - 1).toBe(1)
  })
  test("a structured answer renders on the Brief tab with the brief kit, under the card", () => {
    const structured = JSON.stringify({
      ui: [
        { BottomLine: { props: { level: "CAUTION", reason: "Gusts at KRST.", cite: ["c1"] } } },
        {
          KeyNumbers: {
            props: { items: [{ label: "Fuel burned", value: "5.5", unit: "gal", cite: [] }] },
          },
        },
        { Citations: { props: { items: [{ id: "c1", source: "METAR KRST", locator: "" }] } } },
      ],
    })
    const html = render({ tab: "brief", planningAnswer: structured })
    const panel = html.slice(html.search(/role="tabpanel"[^>]*id="[^"]*-brief"/))
    expect(panel.indexOf('class="wb-verdict"')).toBeLessThan(panel.indexOf("Gusts at KRST."))
    expect(panel).toContain('aria-label="Planning brief"')
    expect(panel).toContain('aria-label="Key numbers"')
    expect(panel).not.toContain("{&quot;ui")
    // Anchors are scoped to this sheet, and the marker links to its source.
    const anchor = panel.match(/id="([^"]*-cite-c1)"/)?.[1]
    expect(anchor).toBeDefined()
    expect(panel).toContain(`href="#${anchor}"`)
    // The card reads the structured bottom line: the planner's CAUTION.
    expect(panel).toContain('class="wb-verdict" data-level="CAUTION"')
  })
  test("a markdown answer still renders as the planning brief", () => {
    const html = render({ tab: "brief", planningAnswer: "Bottom line: GO — VFR all the way." })
    expect(html).toContain('aria-label="Planning brief"')
    expect(html).toContain("VFR all the way.")
  })
  test("tabs control their panels, with a roving tabIndex", () => {
    const view = mountSheet({ tab: "plan" })
    const tabs = [...view.container.querySelectorAll('[role="tab"]')]
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "-1", "0", "-1"])
    for (const t of tabs) {
      const panel = document.getElementById(t.getAttribute("aria-controls") ?? "")
      expect(panel?.getAttribute("aria-labelledby")).toBe(t.id)
    }
    view.unmount()
  })
  test("arrow keys move between tabs", () => {
    const onTabChange = vi.fn()
    const view = mountSheet({ onTabChange })
    const selected = () => view.container.querySelector('[role="tab"][aria-selected="true"]')
    act(() => {
      selected()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    })
    expect(onTabChange).toHaveBeenLastCalledWith("weather")
    act(() => {
      selected()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
    })
    expect(onTabChange).toHaveBeenLastCalledWith("brief")
    view.unmount()
  })
  test("arrow keys step through Weather to Totals & plan", () => {
    const onTabChange = vi.fn()
    const view = mountSheet({ tab: "weather", onTabChange })
    const selected = () => view.container.querySelector('[role="tab"][aria-selected="true"]')
    act(() => {
      selected()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    })
    expect(onTabChange).toHaveBeenLastCalledWith("plan")
    act(() => {
      selected()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
    })
    expect(onTabChange).toHaveBeenLastCalledWith("legs")
    view.unmount()
  })
  test("Home and End move to the first and last tab, with focus", async () => {
    const onTabChange = vi.fn()
    const view = mountSheet({ tab: "plan", onTabChange })
    const tabs = [...view.container.querySelectorAll<HTMLElement>('[role="tab"]')]
    const selected = () => view.container.querySelector('[role="tab"][aria-selected="true"]')
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    act(() => {
      selected()?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    })
    expect(onTabChange).toHaveBeenLastCalledWith("brief")
    await act(frame)
    expect(document.activeElement).toBe(tabs[3])
    act(() => {
      selected()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    })
    expect(onTabChange).toHaveBeenLastCalledWith("legs")
    await act(frame)
    expect(document.activeElement).toBe(tabs[0])
    view.unmount()
  })
  test("the open desktop sheet has a definite height for the grid to fill", () => {
    expect(render()).toMatch(/<section[^>]*class="[^"]* h-\[var\(--wb-sheet-max\)\]/)
    expect(render({ open: false })).toMatch(
      /<section[^>]*class="[^"]*max-h-\[var\(--wb-sheet-max\)\]/,
    )
  })
})
