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
  onNewConversation: () => {},
  onShowMemory: () => {},
  ...overrides,
})

describe("SideNav", () => {
  test("the wordmark is the h1 on desktop and plain text in the drawer", () => {
    const heading = renderToStaticMarkup(<SideNav {...props()} />)
    expect(heading).toMatch(/<h1[^>]*><span class="wb-wordmark">/)
    const label = renderToStaticMarkup(<SideNav {...props({ brand: "label" })} />)
    expect(label).not.toContain("<h1")
    expect(label).toContain('class="wb-wordmark"')
  })

  test("New plan is an ink pill, disabled until hydration", () => {
    const html = renderToStaticMarkup(<SideNav {...props()} />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*bg-wb-text[^>]*>.*New plan<\/button>/s)
  })

  test("the thread list sits between New plan and Memory", () => {
    const html = renderToStaticMarkup(<SideNav {...props()} />)
    expect(html.indexOf("New plan")).toBeLessThan(html.indexOf("KSTP to KRST"))
    expect(html.indexOf("KSTP to KRST")).toBeLessThan(html.indexOf(">Memory<"))
  })

  test("Memory is disabled with nothing waiting and shows the count otherwise", () => {
    expect(renderToStaticMarkup(<SideNav {...props()} />)).toMatch(
      /<button[^>]*disabled=""[^>]*><span>Memory<\/span><\/button>/,
    )
    const html = renderToStaticMarkup(<SideNav {...props({ memoryCount: 3 })} />)
    expect(html).toContain(">3<")
    expect(html).toContain("waiting for review")
  })

  test("any button inside reports a navigation, so the drawer can close", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const onNavigate = vi.fn()
    const onShowMemory = vi.fn()
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<SideNav {...props({ memoryCount: 1, onNavigate, onShowMemory })} />))
    act(() => (container.querySelector("li button") as HTMLElement).click())
    expect(onNavigate).toHaveBeenCalledTimes(1)
    const memory = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Memory"),
    ) as HTMLElement
    act(() => memory.click())
    expect(onShowMemory).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(2)
    act(() => root.unmount())
  })
})
