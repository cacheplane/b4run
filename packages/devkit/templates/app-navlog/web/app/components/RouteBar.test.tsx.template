// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { type Navlog, SAMPLE_NAVLOG } from "../lib/navlog-types"
import type { RouteDraft } from "../lib/route-draft"
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
