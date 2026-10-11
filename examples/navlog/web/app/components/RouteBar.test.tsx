// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Navlog } from "../lib/navlog-types"
import type { RouteDraft } from "../lib/route-draft"
import { SAMPLE_NAVLOG } from "../lib/test-fixtures"
import type { Waypoint } from "../lib/waypoint-search"
import { RouteBar, type RouteBarProps, waypointKindLabel } from "./RouteBar"

const KPAO: Waypoint = {
  id: "KPAO",
  kind: "airport",
  type: "airport",
  name: "Palo Alto Airport",
  lat: 37.461,
  lon: -122.115,
}
const KSNS: Waypoint = {
  id: "KSNS",
  kind: "airport",
  type: "airport",
  name: "Salinas Municipal Airport",
  lat: 36.663,
  lon: -121.603,
}
const SNS: Waypoint = {
  id: "SNS",
  kind: "navaid",
  type: "VORTAC",
  name: "Salinas",
  lat: 36.664,
  lon: -121.603,
  freqKhz: 117300,
}
const KSBA: Waypoint = {
  id: "KSBA",
  kind: "airport",
  type: "airport",
  name: "Santa Barbara Municipal Airport",
  lat: 34.426,
  lon: -119.84,
}
const ALL = [KPAO, KSNS, SNS, KSBA]

/** Prefix match over a tiny table, answered at once. */
const fakeSearch = vi.fn(async (q: string, _signal: AbortSignal) => {
  const lower = q.toLowerCase()
  return {
    results: ALL.filter(
      (w) => w.id.toLowerCase().startsWith(lower) || w.name.toLowerCase().includes(lower),
    ),
    snapshot: "2026-10-10",
  }
})

let container: HTMLDivElement
let root: Root
let drafts: RouteDraft[]
let onReplan: ReturnType<typeof vi.fn<(text: string) => void>>

const props = (overrides: Partial<RouteBarProps> = {}): RouteBarProps => ({
  navlog: null,
  running: false,
  onReplan,
  onDraftChange: (draft) => drafts.push(draft),
  search: fakeSearch,
  ...overrides,
})

function render(overrides: Partial<RouteBarProps> = {}): void {
  act(() => root.render(<RouteBar {...props(overrides)} />))
}

const input = (): HTMLInputElement =>
  container.querySelector('[role="combobox"]') as HTMLInputElement
const field = (label: string): HTMLInputElement =>
  container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
const pills = (): string[] =>
  [...container.querySelectorAll('ol[aria-label="Waypoints"] li .wb-routebar-id')].map(
    (node) => node.textContent ?? "",
  )
const options = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="option"]')]
const submit = (): HTMLButtonElement =>
  container.querySelector('button[type="submit"]') as HTMLButtonElement

const setValue = (element: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

/** Types into the combobox and lets the debounced search answer. */
async function typeQuery(value: string): Promise<void> {
  setValue(input(), value)
  await act(async () => {
    vi.advanceTimersByTime(120)
  })
}

/** Dispatches a keydown on the combobox; returns whether it was prevented. */
function key(name: string): boolean {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })
  act(() => {
    input().dispatchEvent(event)
  })
  return event.defaultPrevented
}

async function addWaypoints(...ids: string[]): Promise<void> {
  for (const id of ids) {
    await typeQuery(id)
    key("Enter")
  }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  fakeSearch.mockClear()
  drafts = []
  onReplan = vi.fn<(text: string) => void>()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe("waypointKindLabel", () => {
  test("airports, VOR-family navaids in MHz, NDBs in kHz", () => {
    expect(waypointKindLabel(KPAO)).toBe("Airport")
    expect(waypointKindLabel(SNS)).toBe("VORTAC 117.30")
    expect(waypointKindLabel({ ...SNS, type: "NDB", freqKhz: 338 })).toBe("NDB 338 kHz")
    const { freqKhz: _omit, ...noFreq } = SNS
    expect(waypointKindLabel(noFreq)).toBe("VORTAC")
  })
})

describe("RouteBar combobox", () => {
  test("form, combobox and listbox carry their roles", async () => {
    render()
    expect(container.querySelector('form[role="search"][aria-label="Route"]')).not.toBeNull()
    expect(input().getAttribute("aria-expanded")).toBe("false")
    expect(input().placeholder).toBe("Type a route: KPAO SNS KSBA")
    await typeQuery("KS")
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement
    expect(input().getAttribute("aria-controls")).toBe(listbox.id)
    expect(input().getAttribute("aria-expanded")).toBe("true")
    expect(options().map((o) => o.querySelector(".wb-routebar-id")?.textContent)).toEqual([
      "KSNS",
      "KSBA",
    ])
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true")
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]?.id)
    expect(container.textContent).toContain("Waypoints: OurAirports 2026-10-10, not for navigation")
  })

  test("options show id, name and kind", async () => {
    render()
    await typeQuery("SNS")
    const navaid = options().find(
      (o) => o.textContent?.includes("Salinas") && o.textContent.includes("VORTAC"),
    )
    expect(navaid?.textContent).toContain("VORTAC 117.30")
  })

  test("typing and Enter adds a pill and clears the input", async () => {
    render()
    await typeQuery("KPA")
    expect(key("Enter")).toBe(true)
    expect(pills()).toEqual(["KPAO"])
    expect(input().value).toBe("")
    expect(input().placeholder).toBe("add waypoint…")
  })

  test("Tab adds the active option", async () => {
    render()
    await typeQuery("KS")
    expect(key("Tab")).toBe(true)
    expect(pills()).toEqual(["KSNS"])
  })

  test("an exact id and space adds it", async () => {
    render()
    await typeQuery("sns")
    expect(key(" ")).toBe(true)
    expect(pills()).toEqual(["SNS"])
    expect(container.querySelector(".wb-routebar-pill-navaid")?.textContent).toContain("SNS")
  })

  test("a partial id and space types the space", async () => {
    render()
    await typeQuery("KS")
    expect(key(" ")).toBe(false)
    expect(pills()).toEqual([])
  })

  test("text that already holds a space types the space", async () => {
    render()
    await typeQuery("Salinas Mun")
    expect(key(" ")).toBe(false)
    expect(pills()).toEqual([])
  })

  test("ArrowDown and ArrowUp move the active option", async () => {
    render()
    await typeQuery("KS")
    key("ArrowDown")
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true")
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1]?.id)
    key("ArrowDown")
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true")
    key("ArrowUp")
    key("Enter")
    expect(pills()).toEqual(["KSBA"])
  })

  test("Escape closes the list", async () => {
    render()
    await typeQuery("KS")
    expect(key("Escape")).toBe(true)
    expect(input().getAttribute("aria-expanded")).toBe("false")
    expect(options()).toEqual([])
  })

  test("Backspace on an empty input removes the last pill", async () => {
    render()
    await addWaypoints("KPAO", "KSBA")
    key("Backspace")
    expect(pills()).toEqual(["KPAO"])
  })

  test("the × removes its pill", async () => {
    render()
    await addWaypoints("KPAO", "SNS", "KSBA")
    act(() => (container.querySelector('[aria-label="Remove SNS"]') as HTMLElement).click())
    expect(pills()).toEqual(["KPAO", "KSBA"])
  })

  test("clicking an option adds it", async () => {
    render()
    await typeQuery("KS")
    act(() => options()[1]?.click())
    expect(pills()).toEqual(["KSBA"])
  })

  test("no search for an empty input", async () => {
    render()
    await typeQuery("   ")
    expect(fakeSearch).not.toHaveBeenCalled()
    await typeQuery("K")
    setValue(input(), "")
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(fakeSearch).toHaveBeenCalledTimes(1)
    expect(options()).toEqual([])
  })

  test("typing debounces and aborts the previous request; a stale answer is dropped", async () => {
    const pending: {
      q: string
      signal: AbortSignal
      resolve: (v: { results: Waypoint[]; snapshot: string }) => void
    }[] = []
    const search = vi.fn(
      (q: string, signal: AbortSignal) =>
        new Promise<{ results: Waypoint[]; snapshot: string }>((resolve) => {
          pending.push({ q, signal, resolve })
        }),
    )
    render({ search })
    setValue(input(), "K")
    setValue(input(), "KS")
    await act(async () => {
      vi.advanceTimersByTime(120)
    })
    expect(search.mock.calls.map(([q]) => q)).toEqual(["KS"])
    await typeQuery("KSB")
    expect(pending.map((p) => p.q)).toEqual(["KS", "KSB"])
    expect(pending[0]?.signal.aborted).toBe(true)
    await act(async () => {
      pending[1]?.resolve({ results: [KSBA], snapshot: "s" })
    })
    await act(async () => {
      pending[0]?.resolve({ results: [KSNS, KSBA], snapshot: "s" })
    })
    expect(options().map((o) => o.querySelector(".wb-routebar-id")?.textContent)).toEqual(["KSBA"])
  })
})

describe("RouteBar replan", () => {
  test("Replan waits for 2 waypoints and an altitude, then sends the exact message", async () => {
    render()
    expect(submit().textContent).toBe("Plan")
    expect(submit().disabled).toBe(true)
    await addWaypoints("KPAO", "SNS")
    expect(submit().disabled).toBe(true)
    setValue(field("Cruise altitude, feet"), "5500")
    expect(submit().disabled).toBe(true)
    setValue(field("Departure time"), "1400Z")
    expect(submit().disabled).toBe(false)
    expect(container.querySelector(".wb-routebar-total")?.textContent).toMatch(/^\d+ nm$/)
    act(() => submit().click())
    expect(onReplan).toHaveBeenCalledWith("Plan KPAO → SNS (VORTAC) at 5500 ft, departing 1400Z.")
    expect(pills()).toEqual(["KPAO", "SNS"])
  })

  test("Enter in the combobox with results adds, it does not submit", async () => {
    render({ navlog: SAMPLE_NAVLOG })
    await typeQuery("KSB")
    act(() => {
      input().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      )
    })
    expect(onReplan).not.toHaveBeenCalled()
    expect(pills()).toEqual(["KSTP", "KRST", "KSBA"])
  })

  test("Enter on an empty combobox is left to submit the form", () => {
    render({ navlog: SAMPLE_NAVLOG })
    expect(key("Enter")).toBe(false)
  })

  test("disabled while a run is in flight", () => {
    render({ navlog: SAMPLE_NAVLOG, running: true })
    expect(submit().textContent).toBe("Replan")
    expect(submit().disabled).toBe(true)
    act(() => (container.querySelector("form") as HTMLFormElement).requestSubmit())
    expect(onReplan).not.toHaveBeenCalled()
  })
})

describe("RouteBar draft sync", () => {
  test("starts from the plan and reports every draft", async () => {
    render({ navlog: SAMPLE_NAVLOG })
    expect(pills()).toEqual(["KSTP", "KRST"])
    expect(field("Cruise altitude, feet").value).toBe("4500")
    expect(field("Departure time").value).toBe("1400Z")
    expect(drafts.at(-1)?.waypoints.map((w) => w.id)).toEqual(["KSTP", "KRST"])
    await addWaypoints("KSBA")
    expect(drafts.at(-1)?.waypoints.map((w) => w.id)).toEqual(["KSTP", "KRST", "KSBA"])
  })

  test("a new plan resets the pills to its waypoints", async () => {
    render({ navlog: SAMPLE_NAVLOG })
    await addWaypoints("KSBA")
    const next: Navlog = {
      ...SAMPLE_NAVLOG,
      altitudeFt: 6500,
      waypoints: [...SAMPLE_NAVLOG.waypoints].reverse(),
    }
    render({ navlog: next })
    expect(pills()).toEqual(["KRST", "KSTP"])
    expect(field("Cruise altitude, feet").value).toBe("6500")
  })

  test("the same plan re-rendered, or no plan, keeps the draft", async () => {
    render({ navlog: SAMPLE_NAVLOG })
    await addWaypoints("KSBA")
    render({ navlog: SAMPLE_NAVLOG, running: true })
    expect(pills()).toEqual(["KSTP", "KRST", "KSBA"])
    act(() => root.unmount())
    root = createRoot(container)
    render()
    await addWaypoints("KPAO")
    render({ running: true })
    expect(pills()).toEqual(["KPAO"])
  })
})

describe("RouteBar reorder", () => {
  const grip = (id: string): HTMLButtonElement =>
    [...container.querySelectorAll<HTMLButtonElement>(".wb-routebar-grip")].find(
      (button) => button.textContent === id,
    ) as HTMLButtonElement
  const status = (): string => container.querySelector('[role="status"]')?.textContent ?? ""
  const gripKey = (id: string, name: string): boolean => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })
    act(() => {
      grip(id).dispatchEvent(event)
    })
    return event.defaultPrevented
  }

  test("each pill's id is a grip that names its position", async () => {
    render()
    await addWaypoints("KPAO", "SNS", "KSBA")
    expect(grip("SNS").getAttribute("aria-label")).toBe("SNS, waypoint 2 of 3")
    const hint = document.getElementById(grip("SNS").getAttribute("aria-describedby") ?? "")
    expect(hint?.textContent).toMatch(/arrow keys/)
  })

  test("arrow keys, Home and End move a waypoint, keep it focused and say where it went", async () => {
    render()
    await addWaypoints("KPAO", "SNS", "KSBA")
    act(() => grip("KSBA").focus())
    expect(gripKey("KSBA", "ArrowLeft")).toBe(true)
    expect(pills()).toEqual(["KPAO", "KSBA", "SNS"])
    expect(document.activeElement).toBe(grip("KSBA"))
    expect(status()).toBe("Moved KSBA to position 2 of 3")
    gripKey("KSBA", "Home")
    expect(pills()).toEqual(["KSBA", "KPAO", "SNS"])
    gripKey("KSBA", "End")
    expect(pills()).toEqual(["KPAO", "SNS", "KSBA"])
    expect(document.activeElement).toBe(grip("KSBA"))
    expect(drafts.at(-1)?.waypoints.map((w) => w.id)).toEqual(["KPAO", "SNS", "KSBA"])
  })

  test("a move past either end, or one that repeats a waypoint, changes nothing", async () => {
    render()
    await addWaypoints("KPAO", "SNS", "KPAO")
    expect(gripKey("KPAO", "ArrowLeft")).toBe(true)
    gripKey("SNS", "ArrowRight")
    expect(pills()).toEqual(["KPAO", "SNS", "KPAO"])
    expect(status()).toBe("")
  })

  test("Replan sends the waypoints in their new order", async () => {
    render()
    await addWaypoints("KPAO", "SNS", "KSBA")
    setValue(field("Cruise altitude, feet"), "5500")
    setValue(field("Departure time"), "1400Z")
    gripKey("KSBA", "ArrowLeft")
    act(() => submit().click())
    expect(onReplan).toHaveBeenCalledWith(
      "Plan KPAO → KSBA → SNS (VORTAC) at 5500 ft, departing 1400Z.",
    )
  })

  describe("dragging", () => {
    /** Lays the pills out 100px apart (middles at 50, 150, …) and fakes pointer capture. */
    function layOut(): HTMLLIElement[] {
      const items = [
        ...container.querySelectorAll<HTMLLIElement>('ol[aria-label="Waypoints"] > li'),
      ]
      for (const [index, item] of items.entries()) {
        item.getBoundingClientRect = () => new DOMRect(index * 100, 0, 100, 32)
        item.setPointerCapture = () => {}
        item.hasPointerCapture = () => false
        item.releasePointerCapture = () => {}
      }
      return items
    }
    function pointer(target: Element, type: string, x: number, pointerType = "mouse"): void {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 })
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        pointerType: { value: pointerType },
      })
      act(() => {
        target.dispatchEvent(event)
      })
    }

    test("a mouse drag previews the order on the map and commits it on drop", async () => {
      render()
      await addWaypoints("KPAO", "SNS", "KSBA")
      const [first] = layOut()
      pointer(first as HTMLLIElement, "pointerdown", 50)
      pointer(first as HTMLLIElement, "pointermove", 52)
      expect(container.querySelector("[data-dragging]")).toBeNull()
      pointer(first as HTMLLIElement, "pointermove", 180)
      expect(container.querySelector("[data-dragging]")).not.toBeNull()
      expect(container.querySelector('[data-drop="after"]')?.textContent).toContain("SNS")
      expect(drafts.at(-1)?.waypoints.map((w) => w.id)).toEqual(["SNS", "KPAO", "KSBA"])
      expect(pills()).toEqual(["KPAO", "SNS", "KSBA"])
      pointer(first as HTMLLIElement, "pointerup", 180)
      expect(pills()).toEqual(["SNS", "KPAO", "KSBA"])
      expect(status()).toBe("Moved KPAO to position 2 of 3")
      expect(container.querySelector("[data-dragging]")).toBeNull()
    })

    test("Escape drops the pill back where it was", async () => {
      render()
      await addWaypoints("KPAO", "SNS", "KSBA")
      const [first] = layOut()
      pointer(first as HTMLLIElement, "pointerdown", 50)
      pointer(first as HTMLLIElement, "pointermove", 280)
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
      })
      pointer(first as HTMLLIElement, "pointerup", 280)
      expect(pills()).toEqual(["KPAO", "SNS", "KSBA"])
      expect(drafts.at(-1)?.waypoints.map((w) => w.id)).toEqual(["KPAO", "SNS", "KSBA"])
    })

    test("a finger drags only after a hold; moving at once scrolls instead", async () => {
      render()
      await addWaypoints("KPAO", "SNS", "KSBA")
      const [first] = layOut()
      pointer(first as HTMLLIElement, "pointerdown", 50, "touch")
      pointer(first as HTMLLIElement, "pointermove", 80, "touch")
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(container.querySelector("[data-dragging]")).toBeNull()
      pointer(first as HTMLLIElement, "pointerup", 80, "touch")

      pointer(first as HTMLLIElement, "pointerdown", 50, "touch")
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(container.querySelector("[data-dragging]")).not.toBeNull()
      pointer(first as HTMLLIElement, "pointermove", 280, "touch")
      pointer(first as HTMLLIElement, "pointerup", 280, "touch")
      expect(pills()).toEqual(["SNS", "KSBA", "KPAO"])
    })

    test("held near the end of an overflowing row, the pill scrolls it and lands past the fold", async () => {
      // Frames on the fake clock, so the auto-scroll loop advances with it.
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16),
      )
      vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
      try {
        render()
        await addWaypoints("KPAO", "SNS", "KSBA", "KSNS")
        const [first] = layOut()
        // A 250px window onto the 400px row of pills: 150px of it scroll.
        const list = container.querySelector('ol[aria-label="Waypoints"]') as HTMLOListElement
        let scrollLeft = 0
        Object.defineProperty(list, "scrollLeft", {
          get: () => scrollLeft,
          set: (value: number) => {
            scrollLeft = Math.max(0, Math.min(150, value))
          },
        })
        list.getBoundingClientRect = () => new DOMRect(0, 0, 250, 32)
        pointer(first as HTMLLIElement, "pointerdown", 50)
        pointer(first as HTMLLIElement, "pointermove", 245)
        // Without scrolling, x = 245 would land the pill third.
        await act(async () => {
          vi.advanceTimersByTime(1000)
        })
        expect(scrollLeft).toBe(150)
        expect(drafts.at(-1)?.waypoints.map((w) => w.id)).toEqual(["SNS", "KSBA", "KSNS", "KPAO"])
        pointer(first as HTMLLIElement, "pointerup", 245)
        expect(pills()).toEqual(["SNS", "KSBA", "KSNS", "KPAO"])
      } finally {
        vi.unstubAllGlobals()
      }
    })

    test("the × removes its pill without starting a drag", async () => {
      render()
      await addWaypoints("KPAO", "SNS")
      layOut()
      const remove = container.querySelector('[aria-label="Remove KPAO"]') as HTMLButtonElement
      pointer(remove, "pointerdown", 80)
      pointer(remove, "pointermove", 180)
      expect(container.querySelector("[data-dragging]")).toBeNull()
      act(() => remove.click())
      expect(pills()).toEqual(["SNS"])
    })
  })
})
