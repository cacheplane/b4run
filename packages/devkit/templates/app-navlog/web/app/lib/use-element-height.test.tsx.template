// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { useElementHeight } from "./use-element-height"

/** The observers alive, by the element each watches; firing one re-measures. */
const observers = new Map<Element, () => void>()

class FakeResizeObserver {
  readonly #callback: () => void
  constructor(callback: () => void) {
    this.#callback = callback
  }
  observe(element: Element): void {
    observers.set(element, this.#callback)
  }
  disconnect(): void {
    for (const [element, callback] of observers) {
      if (callback === this.#callback) observers.delete(element)
    }
  }
}

/** Gives an element a layout height, which jsdom never does on its own. */
const setHeight = (element: Element, height: number): void => {
  element.getBoundingClientRect = () => ({ height }) as DOMRect
}

let heights: number[] = []
let swap: () => void = () => {}

function Probe({ round }: { readonly round: "up" | "down" }) {
  const measured = useElementHeight({ initial: 7, round })
  const [which, setWhich] = useState<"a" | "b">("a")
  swap = () => setWhich("b")
  heights.push(measured.height)
  return which === "a" ? (
    <div key="a" id="a" ref={measured.ref} />
  ) : (
    <section key="b" id="b" ref={measured.ref} />
  )
}

/** jsdom has no layout: gives every element a height before it renders. */
const measureAll = (height: number): void => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ height } as DOMRect)
}

describe("useElementHeight", () => {
  let container: HTMLDivElement
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    heights = []
    observers.clear()
    container = document.createElement("div")
    document.body.append(container)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    container.remove()
  })

  test("keeps the initial height until the element has one", () => {
    const root = createRoot(container)
    act(() => root.render(<Probe round="up" />))
    expect(heights.at(-1)).toBe(7)
    act(() => root.unmount())
  })

  test("rounds up or down as asked, and follows a resize", () => {
    measureAll(40.2)
    const root = createRoot(container)
    act(() => root.render(<Probe round="up" />))
    expect(heights.at(-1)).toBe(41)
    const element = container.querySelector("#a") as Element
    setHeight(element, 52.8)
    act(() => observers.get(element)?.())
    expect(heights.at(-1)).toBe(53)
    act(() => root.render(<Probe round="down" />))
    expect(heights.at(-1)).toBe(52)
    act(() => root.unmount())
  })

  test("a zero height keeps the last one", () => {
    measureAll(30)
    const root = createRoot(container)
    act(() => root.render(<Probe round="up" />))
    const element = container.querySelector("#a") as Element
    setHeight(element, 0)
    act(() => observers.get(element)?.())
    expect(heights.at(-1)).toBe(30)
    act(() => root.unmount())
  })

  test("follows the ref to a new element and stops watching the old one", () => {
    measureAll(30)
    const root = createRoot(container)
    act(() => root.render(<Probe round="up" />))
    const first = container.querySelector("#a") as Element
    act(() => swap())
    const second = container.querySelector("#b") as Element
    expect(observers.has(first)).toBe(false)
    expect(observers.has(second)).toBe(true)
    setHeight(second, 64)
    act(() => observers.get(second)?.())
    expect(heights.at(-1)).toBe(64)
    act(() => root.unmount())
    expect(observers.size).toBe(0)
  })
})
