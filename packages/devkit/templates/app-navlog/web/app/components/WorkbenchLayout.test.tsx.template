// @vitest-environment jsdom
import { act, useContext } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { SheetControlContext } from "./sheet-control"
import { WorkbenchLayout, type WorkbenchLayoutProps } from "./WorkbenchLayout"

const viewport = vi.hoisted(() => ({ desktop: true }))
/** What the layout last handed the map. */
const map = vi.hoisted(
  () =>
    ({}) as {
      categories?: Readonly<Record<string, string>>
      padding?: { readonly left: number; readonly top: number; readonly bottom: number }
    },
)

// Leaflet needs a DOM; the map is a stand-in here (recording its props) and
// `RouteMap` itself is exercised in the browser.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    (mapProps: {
      categories: Readonly<Record<string, string>>
      padding: { readonly left: number; readonly top: number; readonly bottom: number }
    }) => {
      map.categories = mapProps.categories
      map.padding = mapProps.padding
      return <div data-testid="map" />
    },
}))
vi.mock("../lib/use-media-query", () => ({ useMediaQuery: () => viewport.desktop }))

const props = (overrides: Partial<WorkbenchLayoutProps> = {}): WorkbenchLayoutProps => ({
  navlog: SAMPLE_NAVLOG,
  brief: null,
  assistantBrief: "ok",
  chat: <p>transcript</p>,
  rail: (
    <ul>
      <li>
        <button type="button">rail row</button>
      </li>
    </ul>
  ),
  memory: <p>memory</p>,
  memoryCount: 0,
  header: "Thread one",
  onNewConversation: () => {},
  ...overrides,
})

const count = (html: string, needle: string): number => html.split(needle).length - 1

describe("WorkbenchLayout on desktop", () => {
  beforeEach(() => {
    viewport.desktop = true
  })
  test("sidenav, chat, map and navlog are docked panels; no top bar, no tabs", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toContain('aria-label="Navigation"')
    expect(html).toContain('aria-label="Chat"')
    expect(html).toContain('data-testid="map"')
    expect(html).toContain('aria-label="Navlog"')
    expect(html).not.toContain('role="tablist"')
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
  test("the memory panel stays above the conversation; the sidenav counts it", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ memoryCount: 2 })} />)
    expect(html.indexOf("<p>memory</p>")).toBeLessThan(html.indexOf("<main"))
    expect(html).toContain(">2<")
  })
  test("map markers take each airport's worst category, as the chips do", () => {
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
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ brief })} />)
    expect(map.categories).toEqual({ KSTP: "VFR", KRST: "MVFR" })
    expect(html).toContain("KRST MVFR now, VFR at ETA")
  })
  test("the map only leaves a margin: nothing floats over it but the chips", () => {
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
  test("Map and Navlog are disabled until there is a navlog", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ navlog: null })} />)
    expect(html).toMatch(/<button[^>]*id="wb-tab-map"[^>]*disabled=""/)
    expect(html).toMatch(/<button[^>]*id="wb-tab-navlog"[^>]*disabled=""/)
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
  test("on a desktop, a step's openSheet opens the collapsed sheet", () => {
    viewport.desktop = true
    const view = mount()
    const toggle = () =>
      view.container.querySelector('section[aria-label="Navlog"] button[aria-expanded]')
    view.click('section[aria-label="Navlog"] button[aria-expanded]')
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false")
    view.click("[data-open-sheet]")
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true")
    view.unmount()
  })
  test("on a phone, a step's openSheet selects the Navlog tab", () => {
    viewport.desktop = false
    const view = mount()
    const navlogTab = () => view.container.querySelector("#wb-tab-navlog")
    expect(navlogTab()?.getAttribute("aria-selected")).toBe("false")
    view.click("[data-open-sheet]")
    expect(navlogTab()?.getAttribute("aria-selected")).toBe("true")
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
