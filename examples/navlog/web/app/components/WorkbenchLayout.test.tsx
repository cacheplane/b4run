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
      padding?: { readonly bottom: number }
    },
)

// Leaflet needs a DOM; the map is a stand-in here (recording its props) and
// `RouteMap` itself is exercised in the browser.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    (mapProps: {
      categories: Readonly<Record<string, string>>
      padding: { readonly bottom: number }
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
  rail: <p>rail</p>,
  memory: <p>memory</p>,
  header: "Thread one",
  onNewConversation: () => {},
  ...overrides,
})

const count = (html: string, needle: string): number => html.split(needle).length - 1

describe("WorkbenchLayout on desktop", () => {
  beforeEach(() => {
    viewport.desktop = true
  })
  test("dock, strip and sheet float over the map, transcript inside main", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toContain('data-testid="map"')
    expect(html).toContain("<main")
    expect(html).toContain("transcript")
    expect(html).toContain('aria-label="Navlog"')
    expect(html).toContain("Thread one")
    expect(html).toContain("B4.run navlog")
  })
  test("renders one dock, so there is exactly one main and no phone tabs", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(count(html, "<main")).toBe(1)
    expect(count(html, "transcript")).toBe(1)
    expect(html).not.toContain('role="tablist"')
  })
  test("new conversation is in the dock header; the thread list waits behind Threads", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    const button = html.indexOf('aria-label="+ New conversation"')
    expect(button).toBeGreaterThan(-1)
    expect(button).toBeLessThan(html.indexOf("<main"))
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Threads<\/button>/)
    // The server render (this test) is pre-hydration: both header buttons are
    // disabled, so a click cannot land before their handlers exist.
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*disabled=""[^>]*>Threads<\/button>/)
    expect(html).toMatch(/<button[^>]*aria-label="\+ New conversation"[^>]*disabled=""/)
    // Closed, the list is not rendered at all.
    expect(html).not.toContain("<p>rail</p>")
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
  test("the map leaves room for the open sheet, and less when there is no navlog", () => {
    renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    const withSheet = map.padding?.bottom ?? 0
    renderToStaticMarkup(<WorkbenchLayout {...props({ navlog: null })} />)
    expect(map.padding?.bottom).toBeLessThan(withSheet)
  })
  test("without a navlog there is no sheet", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ navlog: null })} />)
    expect(html).not.toContain('aria-label="Navlog"')
  })
  test("the memory panel sits in the dock, not behind a disclosure", () => {
    // Threads is closed, and the memory panel still renders.
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toContain("<p>memory</p>")
    expect(html.indexOf("<p>memory</p>")).toBeLessThan(html.indexOf("<main"))
  })
})

describe("WorkbenchLayout on a phone", () => {
  beforeEach(() => {
    viewport.desktop = false
  })
  test("phone tabs exist for Navlog and Chat", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ assistantBrief: "" })} />)
    expect(html).toContain('role="tablist"')
    expect(html).toContain(">Navlog<")
    expect(html).toContain(">Chat<")
  })
  test("still renders one dock and one main", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(count(html, "<main")).toBe(1)
    expect(count(html, "transcript")).toBe(1)
  })
  test("the bottom sheet has a grip that lowers it to a peek", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toMatch(
      /<button[^>]*aria-expanded="true"[^>]*aria-label="Lower the panel to show the map"/,
    )
  })
  test("the Navlog tab is disabled until there is a navlog", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ navlog: null })} />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Navlog</)
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
  act(() => root.render(<WorkbenchLayout {...props({ chat: <OpenSheet />, ...overrides })} />))
  const click = (selector: string) =>
    act(() => (container.querySelector(selector) as HTMLElement).click())
  return { container, click, unmount: () => act(() => root.unmount()) }
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
