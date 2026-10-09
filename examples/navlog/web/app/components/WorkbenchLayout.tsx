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
import { pairIndexOf, routeGeometry } from "../lib/route-geometry"
import { useHydrated } from "../lib/use-hydrated"
import { useMediaQuery } from "../lib/use-media-query"
import { useSidebarState } from "../lib/use-sidebar-state"
import { resolveVerdict } from "../lib/verdict"
import { type FlightCategory, type WeatherBrief, worstCategory } from "../lib/weather-selectors"
import { ChatDock } from "./ChatDock"
import { Drawer } from "./Drawer"
import { Icon, type IconName } from "./icons"
import { NavlogSheet } from "./NavlogSheet"
import { SideNav } from "./SideNav"
import { type SheetControl, SheetControlContext } from "./sheet-control"
import { WeatherStrip } from "./WeatherStrip"
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
 * An element's height, tracked: the weather chips' height tells the route fit
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
  const [sidebar, toggleSidebar] = useSidebarState()
  const sidenavId = useId()
  const menuButton = useRef<HTMLButtonElement>(null)
  const [hoveredLeg, setHoveredLeg] = useState<number | null>(null)
  const [stripRef, stripHeight] = useMeasuredHeight()
  // No navlog, nothing on the Map and Navlog tabs: a thread switch must not
  // leave an empty tab selected.
  const activeTab: PhoneTab = navlog ? tab : "chat"
  const awaitingApproval = status === "awaiting approval"

  // An approval card lives in the chat; never leave it behind another tab.
  useEffect(() => {
    if (!awaitingApproval) return
    setTab("chat")
    // On a phone the chat is hidden while Memory mode shows; the card must be seen.
    if (!isDesktop) setMemoryOpen(false)
  }, [awaitingApproval, isDesktop])

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
    // Back to the control that opened it (the drawer's copy is gone on a phone).
    requestAnimationFrame(() => memoryButton.current?.focus())
  }, [])

  const toggleMemory = useCallback(() => {
    if (memoryOpen) {
      closeMemory()
      return
    }
    setDrawerOpen(false)
    setMemoryOpen(true)
  }, [memoryOpen, closeMemory])

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
    () => ({ left: MAP_MARGIN, top: stripHeight + MAP_MARGIN, bottom: MAP_MARGIN }),
    [stripHeight],
  )
  const highlightedLeg = navlog && hoveredLeg !== null ? pairIndexOf(navlog, hoveredLeg) : null
  const cruise = navlog ? { cruiseFt: navlog.altitudeFt } : {}
  // The same inputs the sheet resolves its verdict from, so the strip's pill
  // and the sheet's card always show the same level.
  const verdict = useMemo(
    () => resolveVerdict({ weather: brief, answer: assistantBrief, navlog }),
    [brief, assistantBrief, navlog],
  )

  const sheetControl = useMemo<SheetControl>(
    () => ({
      openSheet: () => {
        if (isDesktop) setSheetOpen(true)
        else selectTab("navlog")
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
                <div
                  ref={stripRef}
                  className="pointer-events-none absolute inset-x-4 top-4 z-10 flex justify-end *:pointer-events-auto"
                >
                  <WeatherStrip brief={brief} verdict={verdict} {...cruise} />
                </div>
              </div>
              {navlog ? (
                <div className="wb-sheet-wrap min-h-0 shrink-0">
                  <NavlogSheet
                    navlog={navlog}
                    brief={assistantBrief}
                    weather={brief}
                    open={sheetOpen}
                    onToggle={() => setSheetOpen((value) => !value)}
                    onHoverLeg={setHoveredLeg}
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
          (so its fit and the strip's measured height stay right) and the
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
            <div
              ref={stripRef}
              className="pointer-events-none absolute inset-x-4 top-4 z-10 *:pointer-events-auto"
            >
              <WeatherStrip brief={brief} layout="row" verdict={verdict} {...cruise} />
            </div>
          </div>
          {navlog ? (
            <div
              role="tabpanel"
              id="wb-panel-navlog"
              aria-labelledby="wb-tab-navlog"
              inert={!navlogVisible}
              className={`wb-sheet-wrap ${PANEL_BOX} overflow-auto ${navlogVisible ? "" : "invisible"}`}
            >
              <NavlogSheet
                navlog={navlog}
                brief={assistantBrief}
                weather={brief}
                open={true}
                onToggle={() => {}}
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
                disabled={item.id !== "chat" && navlog === null}
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
