"use client"
import dynamic from "next/dynamic"
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { Navlog } from "../lib/navlog-types"
import type { RouteDraft } from "../lib/route-draft"
import { pairIndexOf, routeGeometry } from "../lib/route-geometry"
import { useHydrated } from "../lib/use-hydrated"
import { useMediaQuery } from "../lib/use-media-query"
import { useSidebarState } from "../lib/use-sidebar-state"
import type { RouteStation } from "../lib/weather-roles"
import { type FlightCategory, type WeatherBrief, worstCategory } from "../lib/weather-selectors"
import { ChatDock } from "./ChatDock"
import { Drawer } from "./Drawer"
import { Icon, type IconName } from "./icons"
import { MarkerPanel } from "./MarkerPanel"
import { NavlogSheet, type SheetTab } from "./NavlogSheet"
import { RouteBar } from "./RouteBar"
import { SideNav } from "./SideNav"
import { type SheetControl, SheetControlContext } from "./sheet-control"
import { Wordmark } from "./Wordmark"

const RouteMap = dynamic(() => import("./RouteMap").then((m) => m.RouteMap), { ssr: false })

export interface MemoryControls {
  /** Whether Memory mode is showing the panel. */
  readonly open: boolean
  readonly onClose: () => void
}

export interface WorkbenchLayoutProps {
  readonly navlog: Navlog | null
  readonly brief: WeatherBrief | null
  /** The reporting stations near the course (`findRouteStations`): map markers and the Weather tab. */
  readonly stations: readonly RouteStation[]
  /** The planning answer of the turn that produced the navlog, shown in the sheet. */
  readonly assistantBrief: string
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

/** The margin the route fit keeps inside the map panel, in pixels. */
const MAP_MARGIN = 24
/** Tailwind's `lg` breakpoint. */
const DESKTOP_QUERY = "(min-width: 1024px)"
/** Where a phone panel sits: all three stack in one box, inside the gutter. */
const PANEL_BOX = "absolute inset-x-2 top-0 bottom-2"

type PhoneTab = "chat" | "map" | "navlog"

const PHONE_TABS: readonly {
  readonly id: PhoneTab
  readonly label: string
  readonly icon: IconName
}[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "map", label: "Map", icon: "map" },
  { id: "navlog", label: "Navlog", icon: "navlog" },
]

/**
 * An element's height, tracked: the route bar's height tells the route fit
 * how much room to leave at the top of the map. Re-attached after every
 * render because which element the ref points at changes with the layout; an
 * unchanged height is a no-op.
 */
function useMeasuredHeight(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element === null || typeof ResizeObserver === "undefined") {
      setHeight(0)
      return
    }
    const measure = (): void => setHeight(Math.ceil(element.getBoundingClientRect().height))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  })
  return [ref, height]
}

/**
 * Desktop (`lg` and up): a grey canvas with three docked columns and no top
 * bar: the sidenav (expanded, or collapsed to a 64px icon rail, remembered
 * per browser), the chat, and the map stacked over the navlog sheet.
 * The route bar floats across the top of the map (on a phone, of the Map
 * tab); clicking an airport or station marker opens its weather panel in the
 * map's lower-left corner.
 * Phone: a top row (menu, wordmark, New plan), one full-screen panel, and a
 * bottom tab bar (Chat, Map, Navlog); the sidenav opens as a drawer.
 *
 * Memory mode (the sidenav's Memory toggle) replaces the right column with the
 * full memory review on a desktop, and shows it as a fourth stacked panel on a
 * phone with no tab selected. The map stays mounted beneath, invisible and
 * inert, so its view and fit survive. Escape inside the review, its close
 * button, New plan, or (phone) any tab leaves the mode.
 *
 * Only the layout that applies is rendered, not both hidden by CSS: the dock
 * holds the chat, and two copies would mean two `<main>` elements, two
 * `CopilotChat`s connecting the same thread and two inputs.
 *
 * Provides `SheetControlContext`, so a step view inside the chat ("See the
 * navlog sheet") can bring the sheet into view: on a desktop it opens the
 * sheet, on a phone it selects the Navlog tab.
 *
 * `wb-root`, `wb-sheet-wrap` and `wb-print-hide` are what the print rules in
 * `theme.css` use so the sheet prints alone, in the page flow.
 */
export function WorkbenchLayout({
  navlog,
  brief,
  stations,
  assistantBrief,
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
  const hydrated = useHydrated()
  const drawerId = useId()
  const [sheetOpen, setSheetOpen] = useState(true)
  const [tab, setTab] = useState<PhoneTab>("chat")
  const [unseen, setUnseen] = useState<{ readonly map: boolean; readonly navlog: boolean }>({
    map: false,
    navlog: false,
  })
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const memoryButton = useRef<HTMLButtonElement>(null)
  const newPlanButton = useRef<HTMLButtonElement>(null)
  const [sidebar, toggleSidebar] = useSidebarState()
  const sidenavId = useId()
  const menuButton = useRef<HTMLButtonElement>(null)
  // The leg selected in the desktop grid, lit on the map; the sheet's tab,
  // lifted so a step's openSheet can land on Legs.
  const [selectedLeg, setSelectedLeg] = useState<number | null>(null)
  const [sheetTab, setSheetTab] = useState<SheetTab>("legs")
  const [barRef, barHeight] = useMeasuredHeight()
  // The route bar's draft, drawn on the map; the marker whose weather panel is open.
  const [draft, setDraft] = useState<RouteDraft | null>(null)
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null)
  // No navlog, nothing on the Navlog tab: a thread switch must not leave it
  // selected. The Map tab holds the route bar, so it works before a plan.
  const activeTab: PhoneTab = tab === "navlog" && navlog === null ? "chat" : tab
  const awaitingApproval = status === "awaiting approval"

  /**
   * Where focus goes once Memory mode has closed, a frame later (after the
   * re-render): the desktop Memory toggle that opened it, unless closing
   * disabled it (nothing left to review); then the sidebar's New plan; on a
   * phone, whose drawer copies are gone, the menu button that opens the drawer.
   */
  const focusAfterMemory = useCallback(() => {
    requestAnimationFrame(() => {
      const target = [memoryButton.current, newPlanButton.current, menuButton.current].find(
        (button): button is HTMLButtonElement => button?.isConnected === true && !button.disabled,
      )
      target?.focus()
    })
  }, [])

  // An approval card lives in the chat; never leave it behind another tab.
  useEffect(() => {
    if (awaitingApproval) setTab("chat")
  }, [awaitingApproval])
  // On a phone the chat is hidden while Memory mode shows; the card must be seen.
  useEffect(() => {
    if (!awaitingApproval || isDesktop || !memoryOpen) return
    setMemoryOpen(false)
    focusAfterMemory()
  }, [awaitingApproval, isDesktop, memoryOpen, focusAfterMemory])

  // A new navlog while the pilot is in the chat: dot the two tabs that show it.
  // Read by the navlog effect below. A layout effect runs before every
  // passive effect of the same commit, so it always sees this render's tab.
  const activeTabRef = useRef(activeTab)
  useLayoutEffect(() => {
    activeTabRef.current = activeTab
  }, [activeTab])
  const previousNavlog = useRef(navlog)
  useEffect(() => {
    if (navlog !== null && navlog !== previousNavlog.current && activeTabRef.current === "chat") {
      setUnseen({ map: true, navlog: true })
    }
    previousNavlog.current = navlog
  }, [navlog])
  // A new navlog (a replan) has new legs: the old selection means nothing.
  // So does an open weather panel: the new brief may not hold its marker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the navlog is the trigger, not an input
  useEffect(() => {
    setSelectedLeg(null)
    setSelectedMarker(null)
  }, [navlog])

  // The drawer is the phone's; a window widened past the breakpoint with it
  // open must not bring it back on the next narrowing.
  useEffect(() => {
    if (isDesktop) setDrawerOpen(false)
  }, [isDesktop])

  const selectTab = useCallback((next: PhoneTab): void => {
    setTab(next)
    setMemoryOpen(false)
    if (next !== "chat") setUnseen((current) => ({ ...current, [next]: false }))
  }, [])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    menuButton.current?.focus()
  }, [])

  const closeMemory = useCallback(() => {
    setMemoryOpen(false)
    focusAfterMemory()
  }, [focusAfterMemory])

  const toggleMemory = useCallback(() => {
    if (memoryOpen) {
      closeMemory()
      return
    }
    setDrawerOpen(false)
    // On a phone the mode would hide the chat, and a pending approval card
    // must stay in view.
    if (!isDesktop && awaitingApproval) return
    setMemoryOpen(true)
  }, [memoryOpen, closeMemory, isDesktop, awaitingApproval])

  // A thread switch needs nothing here: `AppShell` keys the workbench by
  // thread, so a switch remounts the layout with Memory mode off.
  const newConversation = useCallback(() => {
    setMemoryOpen(false)
    onNewConversation()
  }, [onNewConversation])

  // Escape anywhere inside the memory column leaves the mode.
  const onMemoryKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && memoryOpen) closeMemory()
  }

  const geometry = useMemo(() => (navlog ? routeGeometry(navlog) : null), [navlog])
  const categories = useMemo(() => {
    const out: Record<string, FlightCategory> = {}
    for (const airport of brief?.airports ?? []) out[airport.id] = worstCategory(airport)
    return out
  }, [brief])
  const padding = useMemo(
    () => ({ left: MAP_MARGIN, top: barHeight + MAP_MARGIN, bottom: MAP_MARGIN }),
    [barHeight],
  )
  const highlightedLeg = navlog && selectedLeg !== null ? pairIndexOf(navlog, selectedLeg) : null
  const closeMarker = useCallback(() => setSelectedMarker(null), [])

  const sheetControl = useMemo<SheetControl>(
    () => ({
      openSheet: () => {
        if (isDesktop) setSheetOpen(true)
        else selectTab("navlog")
        setSheetTab("legs")
      },
    }),
    [isDesktop, selectTab],
  )

  const chat = (
    <ChatDock header={header} status={status} banner={banner} notices={notices}>
      {conversation}
    </ChatDock>
  )
  const memoryPanel = memory({ open: memoryOpen, onClose: closeMemory })
  const map = (
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
      ref={barRef}
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
        airport={brief?.airports.find((airport) => airport.id.toUpperCase() === markerKey) ?? null}
        station={stations.find((station) => station.id.toUpperCase() === markerKey)}
        onClose={closeMarker}
      />
    )

  if (isDesktop) {
    return (
      <SheetControlContext.Provider value={sheetControl}>
        <div
          data-sidebar={sidebar}
          className="wb-root grid h-dvh grid-cols-[var(--wb-nav-width)_minmax(360px,34%)_minmax(0,1fr)] gap-[var(--wb-gutter)] p-[var(--wb-gutter)]"
        >
          <SideNav
            id={sidenavId}
            brand="heading"
            rail={rail}
            memoryCount={memoryCount}
            memoryOpen={memoryOpen}
            memoryButtonRef={memoryButton}
            newPlanButtonRef={newPlanButton}
            onNewConversation={newConversation}
            onToggleMemory={toggleMemory}
            collapse={{
              collapsed: sidebar === "collapsed",
              onToggle: toggleSidebar,
              controls: sidenavId,
            }}
            className="wb-print-hide"
          />
          <div className="wb-print-hide flex min-h-0 min-w-0">{chat}</div>
          {/*
            Memory mode covers the map column rather than replacing it: the map
            keeps its size, fit and view, and the navlog sheet still prints
            (the print rules force `.wb-sheet` visible).
          */}
          <div className="relative min-h-0 min-w-0">
            <div
              data-map-column=""
              inert={memoryOpen}
              className={`flex h-full min-h-0 flex-col gap-[var(--wb-gutter)] ${memoryOpen ? "invisible" : ""}`}
            >
              <div className="wb-panel wb-print-hide relative min-h-0 flex-1 overflow-hidden">
                {map}
                {routeBar}
                {markerPanel}
              </div>
              {navlog ? (
                <div className="wb-sheet-wrap min-h-0 shrink-0">
                  <NavlogSheet
                    navlog={navlog}
                    brief={assistantBrief}
                    weather={brief}
                    stations={stations}
                    open={sheetOpen}
                    onToggle={() => setSheetOpen((value) => !value)}
                    tab={sheetTab}
                    onTabChange={setSheetTab}
                    onSelectLeg={setSelectedLeg}
                  />
                </div>
              ) : null}
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape is handled for the whole column; its controls are real buttons */}
            <div
              data-memory-column=""
              inert={!memoryOpen}
              onKeyDown={onMemoryKeyDown}
              className={`absolute inset-0 print:hidden ${memoryOpen ? "" : "invisible"}`}
            >
              {memoryPanel}
            </div>
          </div>
        </div>
      </SheetControlContext.Provider>
    )
  }

  // Memory mode shows over the tabs: no panel of theirs is visible under it.
  const chatVisible = !memoryOpen && activeTab === "chat"
  const mapVisible = !memoryOpen && activeTab === "map"
  const navlogVisible = !memoryOpen && activeTab === "navlog"

  return (
    <SheetControlContext.Provider value={sheetControl}>
      <div className="wb-root flex h-dvh flex-col">
        <header className="wb-print-hide flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-[max(8px,env(safe-area-inset-top))]">
          <button
            ref={menuButton}
            type="button"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls={drawerId}
            disabled={!hydrated}
            onClick={() => setDrawerOpen(true)}
            className="wb-focus wb-icon-button"
          >
            <Icon name="menu" />
          </button>
          <h1 className="min-w-0 truncate text-[15px]">
            <Wordmark />
          </h1>
          <button
            type="button"
            aria-label="New plan"
            disabled={!hydrated}
            onClick={newConversation}
            className="wb-focus wb-icon-button wb-icon-button-primary"
          >
            <Icon name="plus" />
          </button>
        </header>
        {/*
          All the panels stay mounted, stacked in one box, and the inactive
          ones are hidden with `invisible` and `inert`, not unmounted and not
          `display: none`: a switch keeps the chat's scroll position, the
          input's draft and any parked approval card; the map keeps its size
          (so its fit and the route bar's measured height stay right) and the
          pilot's view; and the navlog panel still prints from any tab (the
          print rules make `.wb-sheet` visible and flatten its wrapper).
        */}
        <div className="relative min-h-0 flex-1">
          <div
            role="tabpanel"
            id="wb-panel-chat"
            aria-labelledby="wb-tab-chat"
            inert={!chatVisible}
            className={`${PANEL_BOX} flex min-h-0 flex-col print:hidden ${chatVisible ? "" : "invisible"}`}
          >
            {chat}
          </div>
          <div
            role="tabpanel"
            id="wb-panel-map"
            aria-labelledby="wb-tab-map"
            inert={!mapVisible}
            className={`wb-panel ${PANEL_BOX} overflow-hidden print:hidden ${mapVisible ? "" : "invisible"}`}
          >
            {map}
            {routeBar}
            {markerPanel}
          </div>
          {navlog ? (
            <div
              role="tabpanel"
              id="wb-panel-navlog"
              aria-labelledby="wb-tab-navlog"
              inert={!navlogVisible}
              className={`wb-sheet-wrap wb-panel ${PANEL_BOX} overflow-auto ${navlogVisible ? "" : "invisible"}`}
            >
              <NavlogSheet
                navlog={navlog}
                brief={assistantBrief}
                weather={brief}
                stations={stations}
                open={true}
                onToggle={() => {}}
                tab={sheetTab}
                onTabChange={setSheetTab}
                variant="cards"
                collapsible={false}
              />
            </div>
          ) : null}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape is handled for the whole panel; its controls are real buttons */}
          <div
            data-memory-column=""
            inert={!memoryOpen}
            onKeyDown={onMemoryKeyDown}
            className={`${PANEL_BOX} flex min-h-0 flex-col print:hidden ${memoryOpen ? "" : "invisible"}`}
          >
            {memoryPanel}
          </div>
        </div>
        <div
          role="tablist"
          aria-label="Views"
          className="wb-print-hide flex shrink-0 border-t border-wb-border bg-wb-surface pb-[env(safe-area-inset-bottom)]"
        >
          {PHONE_TABS.map((item) => {
            const dotted = item.id !== "chat" && unseen[item.id]
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`wb-tab-${item.id}`}
                aria-selected={!memoryOpen && activeTab === item.id}
                // The Navlog panel only exists with a navlog.
                {...(item.id === "navlog" && navlog === null
                  ? {}
                  : { "aria-controls": `wb-panel-${item.id}` })}
                disabled={item.id === "navlog" && navlog === null}
                className="wb-focus wb-tab"
                onClick={() => selectTab(item.id)}
              >
                <span className="relative">
                  <Icon name={item.icon} />
                  {dotted ? (
                    <span className="wb-tab-dot">
                      <span className="sr-only">, new result</span>
                    </span>
                  ) : null}
                </span>
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
        {drawerOpen ? (
          <Drawer id={drawerId} onClose={closeDrawer}>
            <SideNav
              brand="label"
              rail={rail}
              memoryCount={memoryCount}
              memoryOpen={memoryOpen}
              onNewConversation={newConversation}
              onToggleMemory={toggleMemory}
              onNavigate={closeDrawer}
              className="min-w-0 flex-1"
            />
          </Drawer>
        ) : null}
      </div>
    </SheetControlContext.Provider>
  )
}
