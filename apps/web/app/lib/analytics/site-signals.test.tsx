// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OPEN_DOCS_SEARCH_EVENT } from "../../components/docs/docs-search-events"
import { track } from "./client"
import { SiteSignals } from "./SiteSignals"

let currentPath = "/docs/a"
vi.mock("next/navigation", () => ({ usePathname: () => currentPath }))
vi.mock("./client", () => ({ track: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let visibility: "visible" | "hidden" = "visible"

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(track).mockClear()
  visibility = "visible"
  currentPath = "/docs/a"
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(SiteSignals)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function setVisibility(next: "visible" | "hidden") {
  visibility = next
  document.dispatchEvent(new Event("visibilitychange"))
}

describe("SiteSignals", () => {
  it("fires site:engaged_time at 10 and 30 visible seconds and never for hidden time", () => {
    vi.advanceTimersByTime(5_000)
    setVisibility("hidden")
    vi.advanceTimersByTime(120_000)
    expect(track).not.toHaveBeenCalled()
    setVisibility("visible")
    vi.advanceTimersByTime(5_000)
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenLastCalledWith("site:engaged_time", { engaged_seconds: 10 })
    vi.advanceTimersByTime(20_000)
    expect(track).toHaveBeenCalledTimes(2)
    expect(track).toHaveBeenLastCalledWith("site:engaged_time", { engaged_seconds: 30 })
    vi.advanceTimersByTime(60_000)
    expect(track).toHaveBeenCalledTimes(2)
  })

  it("restarts the engaged-time clock on every pathname change", () => {
    vi.advanceTimersByTime(10_000)
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenLastCalledWith("site:engaged_time", { engaged_seconds: 10 })
    currentPath = "/docs/b"
    act(() => root.render(createElement(SiteSignals)))
    vi.advanceTimersByTime(10_000)
    expect(track).toHaveBeenCalledTimes(2)
    expect(track).toHaveBeenLastCalledWith("site:engaged_time", { engaged_seconds: 10 })
  })

  it("leaves docs:search_open to the search dialog", () => {
    window.dispatchEvent(new Event(OPEN_DOCS_SEARCH_EVENT))
    expect(track).not.toHaveBeenCalled()
  })

  it("reports a delegated click", () => {
    const a = document.createElement("a")
    a.href = "https://example.com/x"
    document.body.appendChild(a)
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    a.remove()
    expect(track).toHaveBeenCalledWith("site:external_link_click", {
      destination_host: "example.com",
      surface: "home",
    })
  })

  it("reports a cta click once and never as an external link", () => {
    const root = document.createElement("div")
    root.setAttribute("data-signal-surface", "footer")
    root.innerHTML = `<a href="https://github.com/cacheplane/b4run" data-cta-id="footer_github"><span>GitHub</span></a>`
    document.body.appendChild(root)
    root.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    root.remove()
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith("site:cta_click", {
      cta_id: "footer_github",
      surface: "footer",
      destination_url: "github.com",
    })
    expect(track).not.toHaveBeenCalledWith("site:external_link_click", expect.anything())
  })

  it("stops listening after unmount", () => {
    act(() => root.unmount())
    window.dispatchEvent(new Event(OPEN_DOCS_SEARCH_EVENT))
    expect(track).not.toHaveBeenCalled()
    root = createRoot(container)
  })
})
