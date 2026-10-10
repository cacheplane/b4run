// @vitest-environment jsdom
import { act, useContext } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { pairIndexOf } from "../lib/route-geometry"
import { SheetControlContext } from "./sheet-control"
import { WorkbenchLayout, type WorkbenchLayoutProps } from "./WorkbenchLayout"

const viewport = vi.hoisted(() => ({ desktop: true }))
/** What the layout last handed the map. */
const map = vi.hoisted(
  () =>
    ({}) as {
      categories?: Readonly<Record<string, string>>
      padding?: { readonly left: number; readonly top: number; readonly bottom: number }
      highlightedLeg?: number | null
      draft?: readonly { readonly id: string }[] | null
      stations?: readonly { readonly id: string }[]
      selectedMarker?: string | null
      onSelectMarker?: (id: string) => void
    },
)
/** What the layout last handed the (stubbed) legs grid. */
const grid = vi.hoisted(() => ({}) as { onSelectLeg?: (index: number | null) => void })

// Leaflet needs a DOM; the map is a stand-in here (recording its props) and
// `RouteMap` itself is exercised in the browser.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    (mapProps: {
      categories: Readonly<Record<string, string>>
      padding: { readonly left: number; readonly top: number; readonly bottom: number }
      highlightedLeg: number | null
      draft: readonly { readonly id: string }[] | null
      stations: readonly { readonly id: string }[]
      selectedMarker: string | null
      onSelectMarker: (id: string) => void
    }) => {
      map.categories = mapProps.categories
      map.padding = mapProps.padding
      map.highlightedLeg = mapProps.highlightedLeg
      map.draft = mapProps.draft
      map.stations = mapProps.stations
      map.selectedMarker = mapProps.selectedMarker
      map.onSelectMarker = mapProps.onSelectMarker
      return <div data-testid="map" />
    },
}))
// pretable needs layout; the grid is a stand-in that hands over its selection callback.
vi.mock("./NavlogGrid", () => ({
  NavlogGrid: (gridProps: { onSelectLeg: (index: number | null) => void }) => {
    grid.onSelectLeg = gridProps.onSelectLeg
    return <div data-testid="pretable" />
  },
}))
vi.mock("../lib/use-media-query", () => ({ useMediaQuery: () => viewport.desktop }))
const sidebar = vi.hoisted(() => ({
  state: "expanded" as "expanded" | "collapsed",
  toggle: vi.fn(),
}))
vi.mock("../lib/use-sidebar-state", () => ({
  useSidebarState: () => [sidebar.state, sidebar.toggle] as const,
}))

const props = (overrides: Partial<WorkbenchLayoutProps> = {}): WorkbenchLayoutProps => ({
  navlog: SAMPLE_NAVLOG,
  brief: null,
  stations: [],
  assistantBrief: "ok",
  chat: <p>transcript</p>,
  rail: (
    <ul>
      <li>
        <button type="button">rail row</button>
      </li>
    </ul>
  ),
  memory: ({ open }) => <p data-memory-open={String(open)}>memory</p>,
  memoryCount: 0,
  header: "Thread one",
  onNewConversation: () => {},
  onReplan: () => {},
  running: false,
  ...overrides,
})

const count = (html: string, needle: string): number => html.split(needle).length - 1

const BRIEF = {
  airports: [
    {
      id: "KSTP",
      now: "VFR" as const,
      atEta: "VFR" as const,
      line: "",
      metar: "METAR KSTP 1",
      taf: "TAF KSTP 2",
    },
    {
      id: "KRST",
      now: "MVFR" as const,
      atEta: "VFR" as const,
      line: "",
      metar: "METAR KRST 1",
      taf: "",
    },
  ],
  winds: [],
  advisories: [],
  note: "",
}

describe("WorkbenchLayout on desktop", () => {
  beforeEach(() => {
    viewport.desktop = true
  })
  test("sidenav, chat, map and navlog are docked panels; no top bar, no view tabs", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toContain('aria-label="Navigation"')
    expect(html).toContain('aria-label="Chat"')
    expect(html).toContain('data-testid="map"')
    expect(html).toContain('aria-label="Navlog"')
    // The sheet's own tabs are the only tablist; the phone's view tabs are absent.
    expect(count(html, 'role="tablist"')).toBe(1)
    expect(html).toContain('aria-label="Navlog views"')
    expect(html).not.toContain('aria-label="Views"')
    expect(html).not.toContain('<header class="wb-topbar')
  })
  test("exactly one main and one h1, the wordmark in the sidenav", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(count(html, "<main")).toBe(1)
    expect(count(html, "<h1")).toBe(1)
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf('aria-label="Chat"'))
  })
  test("the thread list is always in view; there is no Threads disclosure", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toContain("rail row")
    expect(html).not.toContain(">Threads<")
    expect(html.indexOf("New plan")).toBeLessThan(html.indexOf("<main"))
  })
  test("the sidenav counts the memory candidates", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ memoryCount: 2 })} />)
    expect(html).toContain(">2<")
  })
  test("map markers take each airport's worst category", () => {
    const brief = {
      airports: [
        { id: "KSTP", now: "VFR" as const, atEta: "VFR" as const, line: "", metar: "", taf: "" },
        // Improving: MVFR now, VFR at ETA is MVFR on the chip and the marker.
        { id: "KRST", now: "MVFR" as const, atEta: "VFR" as const, line: "", metar: "", taf: "" },
      ],
      winds: [],
      advisories: [],
      note: "",
    }
    renderToStaticMarkup(<WorkbenchLayout {...props({ brief })} />)
    expect(map.categories).toEqual({ KSTP: "VFR", KRST: "MVFR" })
  })
  test("the route bar floats over the map; the weather strip is gone", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ brief: BRIEF })} />)
    expect(count(html, 'aria-label="Route"')).toBe(1)
    expect(html.indexOf('data-testid="map"')).toBeLessThan(html.indexOf('aria-label="Route"'))
    expect(html.indexOf('aria-label="Route"')).toBeLessThan(html.indexOf('aria-label="Navlog"'))
    expect(html).not.toContain('aria-label="Weather"')
    // The verdict pill lives in the sheet now, not over the map.
    expect(html.slice(0, html.indexOf('aria-label="Navlog"'))).not.toContain("wb-verdict-pill")
  })
  test("the route bar starts from the plan's waypoints", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    for (const waypoint of SAMPLE_NAVLOG.waypoints) {
      expect(html).toContain(`aria-label="Remove ${waypoint.id}"`)
    }
  })
  test("the map gets the stations", () => {
    const stations = [
      { id: "KAEL", name: "Albert Lea", lat: 43.68, lon: -93.37, alongNm: 50, offsetNm: 4 },
    ]
    renderToStaticMarkup(<WorkbenchLayout {...props({ stations })} />)
    expect(map.stations).toBe(stations)
  })
  test("the map only leaves a margin: nothing floats over it but the route bar", () => {
    renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(map.padding?.left).toBeLessThan(100)
    expect(map.padding?.bottom).toBeLessThan(100)
  })
  test("without a navlog there is no navlog panel", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ navlog: null })} />)
    expect(html).not.toContain('aria-label="Navlog"')
  })
})

describe("WorkbenchLayout on a phone", () => {
  beforeEach(() => {
    viewport.desktop = false
  })
  test("a top row with the menu, the wordmark h1 and New plan", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toMatch(/<button[^>]*aria-label="Open navigation"/)
    expect(count(html, "<h1")).toBe(1)
    expect(html).toMatch(/<button[^>]*aria-label="New plan"/)
  })
  test("a bottom tab bar: Chat, Map, Navlog; one main", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toContain('role="tablist"')
    expect(html).toContain(">Chat<")
    expect(html).toContain(">Map<")
    expect(html).toContain(">Navlog<")
    expect(count(html, "<main")).toBe(1)
  })
  test("Navlog is disabled until there is a navlog; Map, with the route bar, is not", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ navlog: null })} />)
    expect(html).not.toMatch(/<button[^>]*id="wb-tab-map"[^>]*disabled=""/)
    expect(html).toMatch(/<button[^>]*id="wb-tab-navlog"[^>]*disabled=""/)
  })
  test("the route bar sits in the Map panel; there is no weather strip", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ brief: BRIEF })} />)
    const start = html.indexOf('id="wb-panel-map"')
    const end = html.indexOf('id="wb-panel-navlog"')
    expect(start).toBeGreaterThan(-1)
    expect(count(html.slice(start, end), 'aria-label="Route"')).toBe(1)
    expect(count(html, 'aria-label="Route"')).toBe(1)
    expect(html).not.toContain('aria-label="Weather"')
  })
  test("the drawer is closed, so the thread list is not rendered", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).not.toContain("rail row")
  })
})

/** A step view's "See the navlog sheet", as a chat would hold it. */
function OpenSheet() {
  const { openSheet } = useContext(SheetControlContext)
  return (
    <button type="button" data-open-sheet="" onClick={openSheet}>
      See the navlog sheet
    </button>
  )
}

function mount(overrides: Partial<WorkbenchLayoutProps> = {}) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const render = (next: Partial<WorkbenchLayoutProps> = {}) =>
    act(() =>
      root.render(<WorkbenchLayout {...props({ chat: <OpenSheet />, ...overrides, ...next })} />),
    )
  render()
  const click = (selector: string) =>
    act(() => (container.querySelector(selector) as HTMLElement).click())
  const key = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
      )
    })
  return { container, click, key, render, unmount: () => act(() => root.unmount()) }
}

describe("WorkbenchLayout sheet control", () => {
  const sheetTab = (container: HTMLElement) =>
    container.querySelector('section[aria-label="Navlog"] [role="tab"][aria-selected="true"]')
      ?.textContent
  test("on a desktop, a step's openSheet opens the collapsed sheet on the Legs tab", () => {
    viewport.desktop = true
    const view = mount()
    const toggle = () =>
      view.container.querySelector('section[aria-label="Navlog"] button[aria-expanded]')
    view.click('section[aria-label="Navlog"] [role="tab"]:nth-child(4)')
    expect(sheetTab(view.container)).toBe("Brief")
    view.click('section[aria-label="Navlog"] button[aria-expanded]')
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false")
    view.click("[data-open-sheet]")
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true")
    expect(sheetTab(view.container)).toBe("Legs")
    view.unmount()
  })
  test("on a phone, a step's openSheet selects the Navlog tab and its Legs", () => {
    viewport.desktop = false
    const view = mount()
    const navlogTab = () => view.container.querySelector("#wb-tab-navlog")
    expect(navlogTab()?.getAttribute("aria-selected")).toBe("false")
    view.click('section[aria-label="Navlog"] [role="tab"]:nth-child(3)')
    expect(sheetTab(view.container)).toBe("Totals & plan")
    view.click("[data-open-sheet]")
    expect(navlogTab()?.getAttribute("aria-selected")).toBe("true")
    expect(sheetTab(view.container)).toBe("Legs")
    view.unmount()
  })
})

describe("WorkbenchLayout map highlight", () => {
  beforeEach(() => {
    viewport.desktop = true
  })
  test("the leg selected in the grid lights on the map; clearing it clears the map", () => {
    const view = mount()
    expect(map.highlightedLeg).toBeNull()
    act(() => grid.onSelectLeg?.(0))
    expect(map.highlightedLeg).toBe(pairIndexOf(SAMPLE_NAVLOG, 0))
    act(() => grid.onSelectLeg?.(null))
    expect(map.highlightedLeg).toBeNull()
    view.unmount()
  })
  test("a new navlog clears the selection", () => {
    const view = mount()
    act(() => grid.onSelectLeg?.(0))
    expect(map.highlightedLeg).not.toBeNull()
    view.render({ navlog: { ...SAMPLE_NAVLOG } })
    expect(map.highlightedLeg).toBeNull()
    view.unmount()
  })
})

describe("WorkbenchLayout phone tabs and drawer", () => {
  beforeEach(() => {
    viewport.desktop = false
  })
  test("a new navlog while on Chat dots Map and Navlog; visiting a tab clears its dot", () => {
    const view = mount({ navlog: null })
    expect(view.container.querySelectorAll(".wb-tab-dot")).toHaveLength(0)
    view.render({ navlog: SAMPLE_NAVLOG })
    expect(view.container.querySelectorAll(".wb-tab-dot")).toHaveLength(2)
    view.click("#wb-tab-map")
    expect(view.container.querySelector("#wb-tab-map .wb-tab-dot")).toBeNull()
    expect(view.container.querySelector("#wb-tab-navlog .wb-tab-dot")).not.toBeNull()
    view.unmount()
  })
  test("an inactive panel keeps its size: invisible and inert, never hidden", () => {
    const view = mount()
    const panel = (id: string) => view.container.querySelector(`#wb-panel-${id}`) as HTMLElement
    const isHidden = (element: HTMLElement) =>
      element.classList.contains("invisible") && element.hasAttribute("inert")
    expect(isHidden(panel("map"))).toBe(true)
    expect(panel("map").hidden).toBe(false)
    expect(panel("map").classList.contains("hidden")).toBe(false)
    expect(panel("chat").classList.contains("invisible")).toBe(false)
    expect(panel("chat").hasAttribute("inert")).toBe(false)
    view.click("#wb-tab-map")
    expect(panel("map").classList.contains("invisible")).toBe(false)
    expect(panel("map").hasAttribute("inert")).toBe(false)
    expect(isHidden(panel("chat"))).toBe(true)
    view.unmount()
  })
  test("an approval switches back to Chat", () => {
    const view = mount()
    view.click("#wb-tab-navlog")
    expect(view.container.querySelector("#wb-tab-navlog")?.getAttribute("aria-selected")).toBe(
      "true",
    )
    view.render({ status: "awaiting approval" })
    expect(view.container.querySelector("#wb-tab-chat")?.getAttribute("aria-selected")).toBe("true")
    view.unmount()
  })
  test("the menu opens a modal drawer with the threads; Escape closes it", () => {
    const view = mount()
    view.click('button[aria-label="Open navigation"]')
    const dialog = view.container.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute("aria-modal")).toBe("true")
    expect(dialog?.textContent).toContain("rail row")
    expect(dialog?.contains(document.activeElement)).toBe(true)
    view.key("Escape")
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    view.unmount()
  })
  test("Tab and Shift+Tab wrap inside the open drawer", () => {
    const view = mount()
    view.click('button[aria-label="Open navigation"]')
    const dialog = view.container.querySelector('[role="dialog"]') as HTMLElement
    const items = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled])")]
    const first = items[0]
    const last = items.at(-1)
    expect(items.length).toBeGreaterThan(1)
    act(() => last?.focus())
    view.key("Tab")
    expect(document.activeElement).toBe(first)
    view.key("Tab", { shiftKey: true })
    expect(document.activeElement).toBe(last)
    view.unmount()
  })
  test("Escape returns focus to the menu button", () => {
    const view = mount()
    view.click('button[aria-label="Open navigation"]')
    view.key("Escape")
    expect(document.activeElement).toBe(
      view.container.querySelector('button[aria-label="Open navigation"]'),
    )
    view.unmount()
  })
  test("widening to a desktop closes the drawer", () => {
    const view = mount()
    view.click('button[aria-label="Open navigation"]')
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull()
    viewport.desktop = true
    view.render()
    viewport.desktop = false
    view.render()
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    view.unmount()
  })
  test("the Map tab opens before a plan; the Navlog tab falls back to Chat when the plan goes", () => {
    const view = mount({ navlog: null })
    view.click("#wb-tab-map")
    expect(view.container.querySelector("#wb-tab-map")?.getAttribute("aria-selected")).toBe("true")
    view.render({ navlog: SAMPLE_NAVLOG })
    view.click("#wb-tab-navlog")
    view.render({ navlog: null })
    expect(view.container.querySelector("#wb-tab-chat")?.getAttribute("aria-selected")).toBe("true")
    view.unmount()
  })
  test("a tab names its panel only when the panel exists", () => {
    const view = mount({ navlog: null })
    const tab = (id: string) => view.container.querySelector(`#wb-tab-${id}`)
    expect(tab("navlog")?.hasAttribute("aria-controls")).toBe(false)
    expect(tab("map")?.getAttribute("aria-controls")).toBe("wb-panel-map")
    view.render({ navlog: SAMPLE_NAVLOG })
    expect(tab("navlog")?.getAttribute("aria-controls")).toBe("wb-panel-navlog")
    view.unmount()
  })
  test("choosing a thread in the drawer closes it", () => {
    const view = mount()
    view.click('button[aria-label="Open navigation"]')
    view.click('[role="dialog"] li button')
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    view.unmount()
  })
})

describe("WorkbenchLayout sidebar and Memory mode (desktop)", () => {
  beforeEach(() => {
    viewport.desktop = true
    sidebar.state = "expanded"
  })
  test("the root carries the sidebar state for the grid", () => {
    expect(renderToStaticMarkup(<WorkbenchLayout {...props()} />)).toContain(
      'data-sidebar="expanded"',
    )
    sidebar.state = "collapsed"
    expect(renderToStaticMarkup(<WorkbenchLayout {...props()} />)).toContain(
      'data-sidebar="collapsed"',
    )
  })
  test("the chat column has no memory panel", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    const start = html.indexOf('aria-label="Chat"')
    const chat = html.slice(start, html.indexOf("</section>", start))
    expect(chat).not.toContain("memory")
  })
  test("Memory swaps the right column; the map stays mounted, invisible and inert", () => {
    const view = mount({ memoryCount: 2 })
    const mapColumn = () => view.container.querySelector("[data-map-column]")
    const memoryColumn = () => view.container.querySelector("[data-memory-column]")
    expect(mapColumn()?.hasAttribute("inert")).toBe(false)
    expect(memoryColumn()?.className).toContain("invisible")
    expect(memoryColumn()?.className).toContain("print:hidden")
    view.click('aside [aria-pressed="false"]')
    expect(mapColumn()?.className).toContain("invisible")
    expect(mapColumn()?.hasAttribute("inert")).toBe(true)
    expect(view.container.querySelector('[data-testid="map"]')).not.toBeNull()
    expect(view.container.querySelector(".wb-sheet-wrap")).not.toBeNull()
    expect(memoryColumn()?.className).not.toContain("invisible")
    expect(
      view.container.querySelector("[data-memory-open]")?.getAttribute("data-memory-open"),
    ).toBe("true")
    view.unmount()
  })
  test("Escape inside the memory column leaves the mode", () => {
    const view = mount({ memoryCount: 1 })
    view.click('aside [aria-pressed="false"]')
    act(() => {
      view.container
        .querySelector("[data-memory-column]")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(view.container.querySelector('aside [aria-pressed="true"]')).toBeNull()
    view.unmount()
  })
  test("closing on the last decided candidate focuses New plan, not the disabled Memory", () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    try {
      const view = mount({ memoryCount: 1 })
      view.click('aside [aria-pressed="false"]')
      view.render({ memoryCount: 0 })
      act(() => {
        view.container
          .querySelector("[data-memory-column]")
          ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      act(() => {
        for (const frame of frames.splice(0)) frame(0)
      })
      const newPlan = [...view.container.querySelectorAll("aside button")].find((b) =>
        b.textContent?.includes("New plan"),
      )
      expect(document.activeElement).toBe(newPlan)
      view.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  test("New plan leaves the mode", () => {
    const view = mount({ memoryCount: 1 })
    view.click('aside [aria-pressed="false"]')
    const newPlan = [...view.container.querySelectorAll("aside button")].find((b) =>
      b.textContent?.includes("New plan"),
    ) as HTMLElement
    act(() => newPlan.click())
    expect(view.container.querySelector('aside [aria-pressed="true"]')).toBeNull()
    view.unmount()
  })
})

describe("WorkbenchLayout Memory mode (phone)", () => {
  beforeEach(() => {
    viewport.desktop = false
  })
  test("Memory from the drawer shows the memory panel and deselects every tab; a tab leaves it", () => {
    const view = mount({ memoryCount: 1 })
    view.click('button[aria-label="Open navigation"]')
    view.click('[role="dialog"] [aria-pressed="false"]')
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    for (const id of ["chat", "map", "navlog"]) {
      expect(view.container.querySelector(`#wb-tab-${id}`)?.getAttribute("aria-selected")).toBe(
        "false",
      )
    }
    expect(view.container.querySelector("[data-memory-column]")?.className).not.toContain(
      "invisible",
    )
    expect(view.container.querySelector("#wb-panel-chat")?.hasAttribute("inert")).toBe(true)
    view.click("#wb-tab-chat")
    expect(view.container.querySelector("#wb-tab-chat")?.getAttribute("aria-selected")).toBe("true")
    expect(view.container.querySelector("[data-memory-column]")?.className).toContain("invisible")
    view.unmount()
  })
  test("an approval leaves Memory mode so the card is seen", () => {
    const view = mount({ memoryCount: 1 })
    view.click('button[aria-label="Open navigation"]')
    view.click('[role="dialog"] [aria-pressed="false"]')
    view.render({ status: "awaiting approval" })
    expect(view.container.querySelector("#wb-tab-chat")?.getAttribute("aria-selected")).toBe("true")
    expect(view.container.querySelector("[data-memory-column]")?.className).toContain("invisible")
    view.unmount()
  })
  test("Memory does not open over a pending approval; the chat stays selected", () => {
    const view = mount({ memoryCount: 1, status: "awaiting approval" })
    view.click('button[aria-label="Open navigation"]')
    view.click('[role="dialog"] [aria-pressed="false"]')
    expect(view.container.querySelector("#wb-tab-chat")?.getAttribute("aria-selected")).toBe("true")
    expect(view.container.querySelector("[data-memory-column]")?.className).toContain("invisible")
    view.unmount()
  })
})

describe("WorkbenchLayout route bar and marker panel", () => {
  beforeEach(() => {
    viewport.desktop = true
  })
  const panel = (container: HTMLElement) => container.querySelector('[role="dialog"]')
  test("the route bar hands its draft to the map, and Replan to the shell", () => {
    const onReplan = vi.fn<(text: string) => void>()
    const view = mount({ onReplan })
    expect(map.draft?.map((waypoint) => waypoint.id)).toEqual(
      SAMPLE_NAVLOG.waypoints.map((waypoint) => waypoint.id),
    )
    view.click('form[aria-label="Route"] button[type="submit"]')
    expect(onReplan).toHaveBeenCalledWith(expect.stringMatching(/^Plan KSTP → KRST at 4500 ft/))
    view.click(`button[aria-label="Remove ${SAMPLE_NAVLOG.waypoints[0]?.id}"]`)
    expect(map.draft?.map((waypoint) => waypoint.id)).toEqual(
      SAMPLE_NAVLOG.waypoints.slice(1).map((waypoint) => waypoint.id),
    )
    view.unmount()
  })
  test("Replan waits while a run is in flight", () => {
    const view = mount({ running: true })
    const replan = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Replan",
    )
    expect(replan?.disabled).toBe(true)
    view.unmount()
  })
  test("a marker opens its weather panel with the brief's reports; Close closes it", () => {
    const view = mount({ brief: BRIEF })
    expect(panel(view.container)).toBeNull()
    act(() => map.onSelectMarker?.("krst"))
    expect(map.selectedMarker).toBe("krst")
    const dialog = panel(view.container)
    expect(dialog?.getAttribute("aria-label")).toBe("krst weather")
    expect(dialog?.textContent).toContain("METARKRST 1")
    expect(dialog?.textContent).toContain("MVFR now → VFR at ETA")
    view.click('[role="dialog"] button[aria-label="Close"]')
    expect(panel(view.container)).toBeNull()
    expect(map.selectedMarker).toBeNull()
    view.unmount()
  })
  test("a station's panel names it; a marker missing from the brief says so", () => {
    const stations = [
      { id: "KAEL", name: "Albert Lea", lat: 43.68, lon: -93.37, alongNm: 50, offsetNm: 4 },
    ]
    const view = mount({ brief: BRIEF, stations })
    act(() => map.onSelectMarker?.("KAEL"))
    expect(panel(view.container)?.textContent).toContain("Albert Lea")
    expect(panel(view.container)?.textContent).toContain("No report in the brief")
    view.unmount()
  })
  test("on a phone the panel opens inside the Map panel", () => {
    viewport.desktop = false
    const view = mount({ brief: BRIEF })
    act(() => map.onSelectMarker?.("KSTP"))
    expect(view.container.querySelector('#wb-panel-map [role="dialog"]')).not.toBeNull()
    view.unmount()
  })
  test("a new navlog closes the panel", () => {
    const view = mount({ brief: BRIEF })
    act(() => map.onSelectMarker?.("KSTP"))
    expect(panel(view.container)).not.toBeNull()
    view.render({ navlog: { ...SAMPLE_NAVLOG } })
    expect(panel(view.container)).toBeNull()
    view.unmount()
  })
})
