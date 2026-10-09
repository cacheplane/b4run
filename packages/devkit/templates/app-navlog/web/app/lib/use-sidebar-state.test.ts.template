// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test } from "vitest"
import { readSidebarState, SIDEBAR_STORAGE_KEY, useSidebarState } from "./use-sidebar-state"

afterEach(() => localStorage.clear())

describe("readSidebarState", () => {
  test("defaults to expanded", () => {
    expect(readSidebarState(localStorage)).toBe("expanded")
    expect(readSidebarState(undefined)).toBe("expanded")
  })
  test("reads collapsed, and ignores anything else", () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed")
    expect(readSidebarState(localStorage)).toBe("collapsed")
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "sideways")
    expect(readSidebarState(localStorage)).toBe("expanded")
  })
  test("a storage that throws reads as expanded", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked")
      },
    }
    expect(readSidebarState(throwing)).toBe("expanded")
  })
})

describe("useSidebarState", () => {
  function mount() {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const seen: { state?: string; toggle?: () => void } = {}
    function Probe() {
      const [state, toggle] = useSidebarState()
      seen.state = state
      seen.toggle = toggle
      return null
    }
    const container = document.createElement("div")
    const root = createRoot(container)
    act(() => root.render(createElement(Probe)))
    return { seen, unmount: () => act(() => root.unmount()) }
  }

  test("restores the stored state after mount", () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed")
    const view = mount()
    expect(view.seen.state).toBe("collapsed")
    view.unmount()
  })
  test("toggle flips the state and persists it", () => {
    const view = mount()
    expect(view.seen.state).toBe("expanded")
    act(() => view.seen.toggle?.())
    expect(view.seen.state).toBe("collapsed")
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("collapsed")
    act(() => view.seen.toggle?.())
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("expanded")
    view.unmount()
  })
})
