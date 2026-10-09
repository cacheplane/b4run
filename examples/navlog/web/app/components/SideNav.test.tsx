// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { SideNav, type SideNavProps } from "./SideNav"

const props = (overrides: Partial<SideNavProps> = {}): SideNavProps => ({
  brand: "heading",
  rail: (
    <ul>
      <li>
        <button type="button">KSTP to KRST</button>
      </li>
    </ul>
  ),
  memoryCount: 0,
  memoryOpen: false,
  onNewConversation: () => {},
  onToggleMemory: () => {},
  ...overrides,
})

const collapse = (collapsed: boolean, onToggle = () => {}) => ({
  collapsed,
  onToggle,
  controls: "wb-sidenav",
})

describe("SideNav expanded", () => {
  test("the top row holds the wordmark h1 and the collapse toggle", () => {
    const html = renderToStaticMarkup(<SideNav {...props({ collapse: collapse(false) })} />)
    expect(html).toMatch(/<h1[^>]*><span class="wb-wordmark">/)
    expect(html).toMatch(
      /<button[^>]*aria-label="Collapse sidebar"[^>]*aria-expanded="true"[^>]*aria-controls="wb-sidenav"/,
    )
    expect(html).toContain("wb-header-row")
  })
  test("the drawer copy has no collapse toggle and no h1", () => {
    const html = renderToStaticMarkup(<SideNav {...props({ brand: "label" })} />)
    expect(html).not.toContain("Collapse sidebar")
    expect(html).not.toContain("<h1")
  })
  test("New plan, then the threads, then Memory", () => {
    const html = renderToStaticMarkup(<SideNav {...props()} />)
    expect(html.indexOf("New plan")).toBeLessThan(html.indexOf("KSTP to KRST"))
    expect(html.indexOf("KSTP to KRST")).toBeLessThan(html.indexOf(">Memory<"))
  })
  test("Memory is a toggle; disabled only at zero with the mode off", () => {
    const off = renderToStaticMarkup(<SideNav {...props()} />)
    expect(off).toMatch(/<button[^>]*aria-pressed="false"[^>]*disabled=""/)
    const open = renderToStaticMarkup(<SideNav {...props({ memoryOpen: true })} />)
    expect(open).toMatch(/<button[^>]*aria-pressed="true"/)
    expect(open).not.toMatch(/aria-pressed="true"[^>]*disabled=""/)
    const counted = renderToStaticMarkup(<SideNav {...props({ memoryCount: 3 })} />)
    expect(counted).toContain('class="wb-badge"')
    expect(counted).toContain("waiting for review")
  })
})

describe("SideNav collapsed (the rail)", () => {
  test("icon buttons with labels and tooltips; no thread list; wordmark kept for screen readers", () => {
    const html = renderToStaticMarkup(
      <SideNav {...props({ memoryCount: 2, collapse: collapse(true) })} />,
    )
    expect(html).not.toContain("KSTP to KRST")
    expect(html).toMatch(/<h1 class="sr-only">/)
    expect(html).toMatch(/aria-label="Expand sidebar"[^>]*aria-expanded="false"/)
    expect(html).toMatch(/aria-label="New plan"[^>]*data-tip="New plan"/)
    expect(html).toMatch(/aria-label="Memory"[^>]*data-tip="Memory"/)
    expect(html).toContain('class="wb-badge')
  })
})

describe("SideNav behaviour", () => {
  test("toggles and navigation callbacks fire", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const onToggle = vi.fn()
    const onToggleMemory = vi.fn()
    const onNavigate = vi.fn()
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    act(() =>
      root.render(
        <SideNav
          {...props({
            memoryCount: 1,
            onToggleMemory,
            onNavigate,
            collapse: collapse(false, onToggle),
          })}
        />,
      ),
    )
    act(() => (container.querySelector('[aria-label="Collapse sidebar"]') as HTMLElement).click())
    expect(onToggle).toHaveBeenCalledTimes(1)
    act(() => (container.querySelector("[aria-pressed]") as HTMLElement).click())
    expect(onToggleMemory).toHaveBeenCalledTimes(1)
    act(() => (container.querySelector("li button") as HTMLElement).click())
    expect(onNavigate).toHaveBeenCalled()
    act(() => root.unmount())
  })
})
