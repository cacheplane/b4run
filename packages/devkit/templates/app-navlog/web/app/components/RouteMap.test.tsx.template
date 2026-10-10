// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { type Navlog, SAMPLE_NAVLOG } from "../lib/navlog-types"
import type { DraftWaypoint } from "../lib/route-draft"
import { routeGeometry } from "../lib/route-geometry"
import type { RouteStation } from "../lib/weather-roles"
import { RouteMap, type RouteMapProps } from "./RouteMap"

/**
 * Leaflet over a fake: the contract under test is which layers `RouteMap`
 * puts on the map and how its markers answer, not Leaflet's drawing (the
 * browser harness covers that). Every layer added and still on the map is in
 * `fake.layers`.
 */
interface FakeLayer {
  readonly kind: "polyline" | "marker"
  readonly at: unknown
  readonly options: Record<string, unknown>
  readonly handlers: Record<string, (event: unknown) => void>
  readonly element: HTMLElement
}

const fake = vi.hoisted(() => ({
  layers: new Set<FakeLayer>(),
  fits: [] as unknown[],
}))

vi.mock("leaflet", () => {
  const layer = (kind: FakeLayer["kind"], at: unknown, options: Record<string, unknown>) => {
    const self: FakeLayer & Record<string, unknown> = {
      kind,
      at,
      options,
      handlers: {},
      element: document.createElement("div"),
      addTo() {
        fake.layers.add(self)
        return self
      },
      remove() {
        fake.layers.delete(self)
        return self
      },
      setStyle() {
        return self
      },
      setIcon(icon: unknown) {
        options.icon = icon
        return self
      },
      on(type: string, handler: (event: unknown) => void) {
        self.handlers[type] = handler
        return self
      },
      getElement: () => self.element,
    }
    return self
  }
  const control = () => ({ addTo: () => undefined })
  const L = {
    map: () => ({
      setView: () => undefined,
      getSize: () => ({ x: 800, y: 600 }),
      fitBounds: (bounds: unknown) => fake.fits.push(bounds),
      invalidateSize: () => undefined,
      remove: () => undefined,
    }),
    control: { zoom: control, attribution: control },
    tileLayer: () => ({ addTo: () => undefined }),
    polyline: (points: unknown, options: Record<string, unknown>) =>
      layer("polyline", points, options),
    marker: (at: unknown, options: Record<string, unknown>) => layer("marker", at, options),
    divIcon: (options: unknown) => options,
  }
  return { ...L, default: L }
})

const markers = () => [...fake.layers].filter((l) => l.kind === "marker")
const markerFor = (id: string) => markers().find((m) => m.options.title === id)
const iconOf = (m: FakeLayer) => m.options.icon as { className: string; html: string }
const draftLines = () =>
  [...fake.layers].filter((l) => l.kind === "polyline" && l.options.className === "wb-route-draft")

const PLAN = routeGeometry(SAMPLE_NAVLOG)
const asDraft = (navlog: Navlog): DraftWaypoint[] =>
  navlog.waypoints.map((w) => ({
    id: w.id,
    kind: "airport",
    type: "airport",
    lat: w.lat,
    lon: w.lon,
  }))
const SNS: DraftWaypoint = { id: "ODI", kind: "navaid", type: "VOR", lat: 43.91, lon: -91.25 }

let container: HTMLDivElement
let root: Root
let onSelect: ReturnType<typeof vi.fn<(id: string) => void>>

const props = (overrides: Partial<RouteMapProps> = {}): RouteMapProps => ({
  geometry: PLAN,
  categories: {},
  highlightedLeg: null,
  padding: { left: 24, top: 24, bottom: 24 },
  draft: null,
  stations: [],
  onSelectMarker: onSelect,
  ...overrides,
})

async function render(overrides: Partial<RouteMapProps> = {}): Promise<void> {
  act(() => root.render(<RouteMap {...props(overrides)} />))
  // Leaflet loads in the mount effect: let its import resolve.
  await act(async () => {})
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  fake.layers.clear()
  fake.fits = []
  onSelect = vi.fn<(id: string) => void>()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("RouteMap markers", () => {
  test("airport waypoints are keyboard buttons named by their id; navaids stay labels", async () => {
    const withNavaid: Navlog = {
      ...SAMPLE_NAVLOG,
      waypoints: [
        SAMPLE_NAVLOG.waypoints[0] as Navlog["waypoints"][number],
        { id: "ODI", lat: 43.91, lon: -91.25, kind: "navaid", magneticVariationDeg: 0 },
        SAMPLE_NAVLOG.waypoints[1] as Navlog["waypoints"][number],
      ],
    }
    await render({ geometry: routeGeometry(withNavaid) })
    expect(markerFor("KSTP")?.options).toMatchObject({
      interactive: true,
      keyboard: true,
      alt: "KSTP",
    })
    const navaid = markers().find((m) => iconOf(m).html.includes("ODI"))
    expect(navaid?.options).toMatchObject({ interactive: false, keyboard: false })
    expect(navaid?.handlers.click).toBeUndefined()
  })

  test("a click, Enter or Space selects the marker; another key does not", async () => {
    await render()
    const krst = markerFor("KRST") as FakeLayer
    krst.handlers.click?.({})
    expect(onSelect).toHaveBeenLastCalledWith("KRST")
    const press = (key: string) => {
      const originalEvent = new KeyboardEvent("keydown", { key, cancelable: true })
      krst.handlers.keydown?.({ originalEvent })
      return originalEvent
    }
    expect(press("Enter").defaultPrevented).toBe(true)
    expect(press(" ").defaultPrevented).toBe(true)
    press("a")
    expect(onSelect).toHaveBeenCalledTimes(3)
  })

  test("a new callback identity calls the new callback without redrawing", async () => {
    await render()
    const before = markerFor("KSTP")
    const next = vi.fn<(id: string) => void>()
    await render({ onSelectMarker: next })
    expect(markerFor("KSTP")).toBe(before)
    before?.handlers.click?.({})
    expect(next).toHaveBeenCalledWith("KSTP")
    expect(onSelect).not.toHaveBeenCalled()
  })

  test("stations are small grey buttons with their category; a planned airport is not repeated", async () => {
    const stations: RouteStation[] = [
      { id: "KOWA", name: "Owatonna", lat: 44.12, lon: -93.26, alongNm: 30, offsetNm: 3 },
      { id: "KRST", name: "Rochester", lat: 43.9, lon: -92.5, alongNm: 66, offsetNm: 0 },
    ]
    await render({ stations, categories: { KOWA: "MVFR" } })
    const kowa = markerFor("KOWA") as FakeLayer
    expect(iconOf(kowa).className).toBe("wb-wp wb-wp-station")
    expect(iconOf(kowa).html).toContain("KOWA <b>MVFR</b>")
    expect(iconOf(kowa).html).not.toContain("data-cat")
    kowa.handlers.click?.({})
    expect(onSelect).toHaveBeenCalledWith("KOWA")
    expect(markers().filter((m) => m.options.title === "KRST")).toHaveLength(1)
  })

  test("the open panel's marker reads as expanded", async () => {
    await render({ selectedMarker: "KRST" })
    expect(markerFor("KRST")?.element.getAttribute("aria-expanded")).toBe("true")
    expect(markerFor("KSTP")?.element.getAttribute("aria-expanded")).toBe("false")
  })
})

describe("RouteMap draft", () => {
  test("a draft that is the planned route draws nothing extra", async () => {
    await render({ draft: asDraft(SAMPLE_NAVLOG) })
    expect(draftLines()).toHaveLength(0)
  })

  test("a draft that differs draws one dashed line, and dots only for unplanned waypoints", async () => {
    const [first, last] = asDraft(SAMPLE_NAVLOG)
    await render({ draft: [first as DraftWaypoint, SNS, last as DraftWaypoint] })
    expect(draftLines()).toHaveLength(1)
    const dots = markers().filter((m) => iconOf(m).className === "wb-wp wb-wp-draft")
    expect(dots).toHaveLength(1)
    expect(iconOf(dots[0] as FakeLayer).html).toContain("ODI")
    // Back to the plan: the draft layers go.
    await render({ draft: asDraft(SAMPLE_NAVLOG) })
    expect(draftLines()).toHaveLength(0)
    expect(markers().filter((m) => iconOf(m).className === "wb-wp wb-wp-draft")).toHaveLength(0)
  })

  test("with no plan, the map fits the draft once it has two waypoints", async () => {
    const [first, last] = asDraft(SAMPLE_NAVLOG)
    await render({ geometry: null, draft: [first as DraftWaypoint] })
    expect(fake.fits).toHaveLength(0)
    expect(draftLines()).toHaveLength(0)
    expect(markers()).toHaveLength(1)
    await render({ geometry: null, draft: [first as DraftWaypoint, last as DraftWaypoint] })
    expect(draftLines()).toHaveLength(1)
    expect(fake.fits.at(-1)).toEqual([
      [43.9083, -93.0603],
      [44.9346, -92.49],
    ])
  })

  test("with a plan, the draft never moves the map", async () => {
    await render()
    const fits = fake.fits.length
    await render({ draft: [...asDraft(SAMPLE_NAVLOG), SNS] })
    expect(fake.fits).toHaveLength(fits)
  })
})
