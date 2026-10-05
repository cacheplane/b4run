import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { WorkbenchLayout, type WorkbenchLayoutProps } from "./WorkbenchLayout"

const viewport = vi.hoisted(() => ({ desktop: true }))

// Leaflet needs a DOM; the map is a stand-in here and `RouteMap` is exercised in the browser.
vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="map" /> }))
vi.mock("../lib/use-media-query", () => ({ useMediaQuery: () => viewport.desktop }))

const props = (overrides: Partial<WorkbenchLayoutProps> = {}): WorkbenchLayoutProps => ({
  navlog: SAMPLE_NAVLOG,
  brief: null,
  assistantBrief: "ok",
  dock: <p>transcript</p>,
  composer: <p>composer</p>,
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
  test("the new-conversation button is in the dock header, outside the Threads disclosure", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    const button = html.indexOf('aria-label="+ New conversation"')
    expect(button).toBeGreaterThan(-1)
    expect(button).toBeLessThan(html.indexOf("<details"))
    expect(button).toBeLessThan(html.indexOf("<main"))
  })
  test("without a navlog there is no sheet", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ navlog: null })} />)
    expect(html).not.toContain('aria-label="Navlog"')
  })
  test("the memory panel sits in the dock, not behind a disclosure", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    const memoryAt = html.indexOf("memory")
    expect(memoryAt).toBeGreaterThan(-1)
    expect(html.slice(0, memoryAt).lastIndexOf("<details")).toBeLessThan(
      html.slice(0, memoryAt).lastIndexOf("</details>"),
    )
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
  test("the Navlog tab is disabled until there is a navlog", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ navlog: null })} />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Navlog</)
  })
})
