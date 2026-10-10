// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import type { AirportWeather } from "../lib/weather-selectors"
import { MarkerPanel, type MarkerPanelProps } from "./MarkerPanel"

const KRST: AirportWeather = {
  id: "KRST",
  now: "MVFR",
  atEta: "VFR",
  line: "",
  metar: "METAR KRST 061853Z 31012KT 10SM BKN025",
  taf: "TAF KRST 061720Z 0618/0718 31010KT P6SM BKN030",
}

const props = (overrides: Partial<MarkerPanelProps> = {}): MarkerPanelProps => ({
  id: "KRST",
  airport: KRST,
  onClose: () => {},
  ...overrides,
})

describe("MarkerPanel", () => {
  test("a dialog named for the marker, with the category now → ETA and both reports", () => {
    const html = renderToStaticMarkup(<MarkerPanel {...props()} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="KRST weather"')
    expect(html).toContain('data-cat="MVFR"')
    expect(html).toContain("MVFR now → VFR at ETA")
    // Under its own label, each report drops the label's word: "METAR KRST …" reads "KRST …".
    expect(html).toMatch(
      new RegExp(
        `>METAR</p><pre class="[^"]*font-mono[^"]*">${KRST.metar.replace(/^METAR /, "")}</pre>`,
      ),
    )
    expect(html).not.toContain("METAR METAR")
    expect(html).toContain(KRST.taf.replace(/^TAF /, ""))
    expect(html).toMatch(/<button[^>]*aria-label="Close"/)
  })
  test("a station shows its name; a report the brief lacks says so", () => {
    const html = renderToStaticMarkup(
      <MarkerPanel
        {...props({
          id: "KAEL",
          airport: { ...KRST, id: "KAEL", taf: "" },
          station: { name: "Albert Lea" },
        })}
      />,
    )
    expect(html).toContain("Albert Lea")
    expect(html).toContain("No TAF in the brief")
  })
  test("a marker missing from the brief", () => {
    const html = renderToStaticMarkup(<MarkerPanel {...props({ airport: null })} />)
    expect(html).toContain("No report in the brief")
    expect(html).not.toContain("<pre")
    expect(html).not.toContain("wb-cat")
  })
})

describe("MarkerPanel focus and keys", () => {
  function mount(overrides: Partial<MarkerPanelProps> = {}) {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    document.body.append(container)
    const opener = document.createElement("button")
    opener.textContent = "KRST marker"
    container.append(opener)
    const host = document.createElement("div")
    container.append(host)
    const root = createRoot(host)
    opener.focus()
    const render = (open: boolean, next: Partial<MarkerPanelProps> = {}) =>
      act(() => root.render(open ? <MarkerPanel {...props({ ...overrides, ...next })} /> : null))
    render(true)
    return {
      container,
      opener,
      render,
      cleanup: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  test("focus moves to the close button on open and back to the opener on close", () => {
    const view = mount()
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close")
    view.render(false)
    expect(document.activeElement).toBe(view.opener)
    view.cleanup()
  })
  test("Escape inside the dialog closes it; Close does too", () => {
    const onClose = vi.fn()
    const view = mount({ onClose })
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      )
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => (view.container.querySelector('button[aria-label="Close"]') as HTMLElement).click())
    expect(onClose).toHaveBeenCalledTimes(2)
    view.cleanup()
  })
  test("a second marker re-targets the panel and takes focus back into it", () => {
    const view = mount()
    const second = document.createElement("button")
    view.container.prepend(second)
    act(() => second.focus())
    view.render(true, { id: "KAEL", airport: null })
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close")
    expect(view.container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "KAEL weather",
    )
    view.render(false)
    expect(document.activeElement).toBe(second)
    view.cleanup()
  })
})
