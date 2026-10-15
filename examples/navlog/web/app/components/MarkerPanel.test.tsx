// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import type { AirportWeather } from "../lib/forecast"
import { SAMPLE_FORECAST } from "../lib/test-fixtures"
import { MarkerPanel, type MarkerPanelProps } from "./MarkerPanel"

const KBDN = SAMPLE_FORECAST.airports.find((a) => a.id === "KBDN") as AirportWeather

const props = (overrides: Partial<MarkerPanelProps> = {}): MarkerPanelProps => ({
  id: "KBDN",
  airport: KBDN,
  onClose: () => {},
  ...overrides,
})

describe("MarkerPanel", () => {
  test("a dialog named for the marker, with its category and the forecast's raw reports", () => {
    const html = renderToStaticMarkup(<MarkerPanel {...props()} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="KBDN weather"')
    expect(html).toContain('data-cat="VFR"')
    expect(html).toMatch(
      new RegExp(`>METAR</p><pre class="[^"]*font-mono[^"]*">${KBDN.metar?.raw}</pre>`),
    )
    // Under its own label, the TAF drops the label's word: "TAF KBDN …" reads "KBDN …".
    expect(html).toContain(`>${(KBDN.taf?.raw ?? "").replace(/^TAF /, "")}</pre>`)
    expect(html).not.toContain("TAF TAF")
    expect(html).toMatch(/<button[^>]*aria-label="Close"/)
  })
  test("the category now and at the airport's time, when they differ", () => {
    const html = renderToStaticMarkup(
      <MarkerPanel
        {...props({ airport: { ...KBDN, categoryNow: "MVFR", categoryAtTime: "VFR" } })}
      />,
    )
    expect(html).toContain('data-cat="VFR"')
    expect(html).toContain("MVFR now → VFR at 1905Z")
  })
  test("a station shows its name; a report the forecast lacks says so", () => {
    const html = renderToStaticMarkup(
      <MarkerPanel
        {...props({
          id: "KS33",
          airport: { ...KBDN, id: "KS33", taf: null, metar: null },
          station: { name: "Madras Municipal" },
        })}
      />,
    )
    expect(html).toContain("Madras Municipal")
    expect(html).toContain("No METAR")
    expect(html).toContain("No TAF issued")
  })
  test("a marker missing from the forecast", () => {
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
