"use client"
import dynamic from "next/dynamic"
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import type { Navlog } from "../lib/navlog-types"
import type { RouteDraft } from "../lib/route-draft"
import { routeGeometry } from "../lib/route-geometry"
import { useElementHeight } from "../lib/use-element-height"
import { useMediaQuery } from "../lib/use-media-query"
import type { RouteStation } from "../lib/weather-roles"
import { type FlightCategory, type WeatherBrief, worstCategory } from "../lib/weather-selectors"
import { ChatDock } from "./ChatDock"
import { DesktopWorkbench } from "./DesktopWorkbench"
import { MarkerPanel } from "./MarkerPanel"
import type { SheetTab } from "./NavlogSheet"
import { PhoneWorkbench } from "./PhoneWorkbench"
import { RouteBar } from "./RouteBar"

const RouteMap = dynamic(() => import("./RouteMap").then((m) => m.RouteMap), { ssr: false })

export interface MemoryControls {
  /** Whether Memory mode is showing the panel. */
  readonly open: boolean
  readonly onClose: () => void
}

export interface WorkbenchLayoutProps {
  readonly navlog: Navlog | null
  /** The weather subagent's parsed brief: marker colors and the weather panels. */
  readonly weatherBrief: WeatherBrief | null
  /** The reporting stations near the course (`findRouteStations`): map markers and the Weather tab. */
  readonly stations: readonly RouteStation[]
  /** The planning answer of the turn that produced the navlog, shown in the sheet. */
  readonly planningAnswer: string
  readonly header: string
  readonly status?: string | undefined
  /** The thread list (`ThreadRail`), for the sidenav. */
  readonly rail: ReactNode
  /** The memory review (`MemoryPanel`), given Memory mode's state. */
  readonly memory: (controls: MemoryControls) => ReactNode
  /** Memory candidates waiting, for the sidenav's count. */
  readonly memoryCount: number
  /** The chat's failure banner (`RunError`), or nothing. */
  readonly banner?: ReactNode
  /** The chat's content-parts-dropped notices, or nothing. */
  readonly notices?: ReactNode
  /** The conversation (`NavlogChat`): messages and input. */
  readonly chat: ReactNode
  readonly onNewConversation: () => void
  /** Sends the route bar's Replan message as a chat message. */
  readonly onReplan: (text: string) => void
  /** A run is in flight: the route bar's Replan waits. */
  readonly running: boolean
}

/** What the navlog sheet shows, the same in both layouts. */
export interface WorkbenchSheet {
  readonly planningAnswer: string
  readonly weatherBrief: WeatherBrief | null
  readonly stations: readonly RouteStation[]
  /** The sheet's tab, lifted here so either layout's `openSheet` can land on Legs. */
  readonly tab: SheetTab
  readonly onTabChange: (tab: SheetTab) => void
}

/**
 * What `WorkbenchLayout` hands the layout it renders: the state both layouts
 * share and the panels they arrange. Each layout keeps the rest (the desktop's
 * sidebar and sheet, the phone's tabs and drawer) to itself.
 */
export interface WorkbenchViewProps {
  readonly navlog: Navlog | null
  readonly sheet: WorkbenchSheet
  /** The thread list, for the sidenav. */
  readonly rail: ReactNode
  /** Memory candidates waiting, for the sidenav's count. */
  readonly memoryCount: number
  /** The memory review; the layout renders it with its own close (and focus return). */
  readonly memory: (controls: MemoryControls) => ReactNode
  /** Whether Memory mode is on. */
  readonly memoryOpen: boolean
  readonly onMemoryOpenChange: (open: boolean) => void
  /** Starts a new plan, leaving Memory mode. */
  readonly onNewConversation: () => void
  /** The chat dock, with the conversation inside. */
  readonly chat: ReactNode
  /**
   * The route map, given the leg to light: a render function because the leg
   * is selected in the desktop's grid, which only `DesktopWorkbench` has.
   */
  readonly renderMap: (highlightedLeg: number | null) => ReactNode
  /** The route bar, in the slot that floats over the map and is measured for the route fit. */
  readonly routeBar: ReactNode
  /** The open marker's weather panel, over the map's lower-left corner, or nothing. */
  readonly markerPanel: ReactNode
}

/** The margin the route fit keeps inside the map panel, in pixels. */
const MAP_MARGIN = 24
/** Tailwind's `lg` breakpoint. */
const DESKTOP_QUERY = "(min-width: 1024px)"

/**
 * The workbench: the chat, the route map and the navlog sheet, laid out for
 * the screen. `DesktopWorkbench` (`lg` and up) docks them in columns;
 * `PhoneWorkbench` shows one at a time behind a bottom tab bar.
 *
 * This component holds what the two share: Memory mode, the sheet's tab, the
 * route bar's draft (drawn on the map), the marker whose weather panel is
 * open, and the route bar's measured height. It builds the panels both
 * layouts place: the chat dock, the map, the route bar floating across the
 * top of the map, and the marker panel (clicking an airport or station marker
 * opens its weather in the map's lower-left corner).
 *
 * Memory mode (the sidenav's Memory toggle) shows the full memory review in
 * place of the map column on a desktop, and as a fourth stacked panel with no
 * tab selected on a phone. The map stays mounted beneath, invisible and
 * inert, so its view and fit survive. Escape inside the review, its close
 * button, New plan, or (phone) any tab leaves the mode.
 *
 * Only the layout that applies is rendered, not both hidden by CSS: the dock
 * holds the chat, and two copies would mean two `<main>` elements, two
 * `CopilotChat`s connecting the same thread and two inputs. State only one
 * layout uses lives in that layout, so crossing the breakpoint resets it
 * (the phone's drawer closes, the desktop's sheet reopens).
 *
 * Each layout provides `SheetControlContext`, so a step view inside the chat
 * ("See the navlog sheet") can bring the sheet into view on its Legs tab.
 */
export function WorkbenchLayout({
  navlog,
  weatherBrief,
  stations,
  planningAnswer,
  header,
  status,
  rail,
  memory,
  memoryCount,
  banner,
  notices,
  chat: conversation,
  onNewConversation,
  onReplan,
  running,
}: WorkbenchLayoutProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [sheetTab, setSheetTab] = useState<SheetTab>("legs")
  // The route bar's height tells the route fit how much room to leave at the
  // top of the map. The bar's slot is a different element in each layout; the
  // hook's callback ref follows it across a switch.
  const bar = useElementHeight({ initial: 0, round: "up" })
  // The route bar's draft, drawn on the map; the marker whose weather panel is open.
  const [draft, setDraft] = useState<RouteDraft | null>(null)
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null)

  // A new navlog (a replan) comes with a new weather brief, which may not hold
  // the open panel's marker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the navlog is the trigger, not an input
  useEffect(() => {
    setSelectedMarker(null)
  }, [navlog])

  // A thread switch needs nothing here: `AppShell` keys the workbench by
  // thread, so a switch remounts the layout with Memory mode off.
  const newConversation = useCallback(() => {
    setMemoryOpen(false)
    onNewConversation()
  }, [onNewConversation])

  const geometry = useMemo(() => (navlog ? routeGeometry(navlog) : null), [navlog])
  const categories = useMemo(() => {
    const out: Record<string, FlightCategory> = {}
    for (const airport of weatherBrief?.airports ?? []) out[airport.id] = worstCategory(airport)
    return out
  }, [weatherBrief])
  const padding = useMemo(
    () => ({ left: MAP_MARGIN, top: bar.height + MAP_MARGIN, bottom: MAP_MARGIN }),
    [bar.height],
  )
  const closeMarker = useCallback(() => setSelectedMarker(null), [])

  const chat = (
    <ChatDock header={header} status={status} banner={banner} notices={notices}>
      {conversation}
    </ChatDock>
  )
  const renderMap = (highlightedLeg: number | null): ReactNode => (
    <RouteMap
      geometry={geometry}
      categories={categories}
      highlightedLeg={highlightedLeg}
      padding={padding}
      draft={draft?.waypoints ?? null}
      stations={stations}
      selectedMarker={selectedMarker}
      onSelectMarker={setSelectedMarker}
    />
  )
  // Over the map, in the slot the route fit measures: the full width of the panel.
  const routeBar = (
    <div
      ref={bar.ref}
      className="wb-routebar-slot pointer-events-none absolute inset-x-4 top-4 z-10 *:pointer-events-auto"
    >
      <RouteBar navlog={navlog} running={running} onReplan={onReplan} onDraftChange={setDraft} />
    </div>
  )
  const markerKey = selectedMarker?.toUpperCase()
  const markerPanel =
    selectedMarker === null ? null : (
      <MarkerPanel
        id={selectedMarker}
        airport={
          weatherBrief?.airports.find((airport) => airport.id.toUpperCase() === markerKey) ?? null
        }
        station={stations.find((station) => station.id.toUpperCase() === markerKey)}
        onClose={closeMarker}
      />
    )

  const view: WorkbenchViewProps = {
    navlog,
    sheet: { planningAnswer, weatherBrief, stations, tab: sheetTab, onTabChange: setSheetTab },
    rail,
    memoryCount,
    memory,
    memoryOpen,
    onMemoryOpenChange: setMemoryOpen,
    onNewConversation: newConversation,
    chat,
    renderMap,
    routeBar,
    markerPanel,
  }
  return isDesktop ? (
    <DesktopWorkbench {...view} />
  ) : (
    <PhoneWorkbench {...view} awaitingApproval={status === "awaiting approval"} />
  )
}
