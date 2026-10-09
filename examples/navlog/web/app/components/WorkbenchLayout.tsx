"use client"
import dynamic from "next/dynamic"
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import type { Navlog } from "../lib/navlog-types"
import { pairIndexOf, routeGeometry } from "../lib/route-geometry"
import { useHydrated } from "../lib/use-hydrated"
import { useMediaQuery } from "../lib/use-media-query"
import { resolveVerdict } from "../lib/verdict"
import { type FlightCategory, type WeatherBrief, worstCategory } from "../lib/weather-selectors"
import { ChatDock } from "./ChatDock"
import { Drawer } from "./Drawer"
import { revealMemoryPanel } from "./memory-anchor"
import { NavlogSheet } from "./NavlogSheet"
import { SideNav } from "./SideNav"
import { type SheetControl, SheetControlContext } from "./sheet-control"
import { WeatherStrip } from "./WeatherStrip"
import { Wordmark } from "./Wordmark"

const RouteMap = dynamic(() => import("./RouteMap").then((m) => m.RouteMap), { ssr: false })

export interface WorkbenchLayoutProps {
  readonly navlog: Navlog | null
  readonly brief: WeatherBrief | null
  /** The planning answer of the turn that produced the navlog, shown in the sheet. */
  readonly assistantBrief: string
  readonly header: string
  readonly status?: string | undefined
  /** The thread list (`ThreadRail`), for the sidenav. */
  readonly rail: ReactNode
  readonly memory: ReactNode
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
/** Tailwind's `md` breakpoint. */
const DESKTOP_QUERY = "(min-width: 768px)"
/** Where a phone panel sits: all three stack in one box, inside the gutter. */
const PANEL_BOX = "absolute inset-x-2 top-0 bottom-2"

type PhoneTab = "chat" | "map" | "navlog"

const PHONE_TABS: readonly {
  readonly id: PhoneTab
  readonly label: string
  readonly icon: string
}[] = [
  {
    id: "chat",
    label: "Chat",
    icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  },
  { id: "map", label: "Map", icon: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" },
  { id: "navlog", label: "Navlog", icon: "M4 6h16M4 12h16M4 18h10" },
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

function Icon({ path }: { readonly path: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
    >
      <path d={path} />
    </svg>
  )
}

/**
 * Desktop (`md` and up): a grey canvas with three docked columns and no top
 * bar: the sidenav, the chat, and the map stacked over the navlog sheet.
 * Phone: a top row (menu, wordmark, New plan), one full-screen panel, and a
 * bottom tab bar (Chat, Map, Navlog); the sidenav opens as a drawer.
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
  const menuButton = useRef<HTMLButtonElement>(null)
  const [hoveredLeg, setHoveredLeg] = useState<number | null>(null)
  const [stripRef, stripHeight] = useMeasuredHeight()
  // No navlog, nothing on the Map and Navlog tabs: a thread switch must not
  // leave an empty tab selected.
  const activeTab: PhoneTab = navlog ? tab : "chat"
  const awaitingApproval = status === "awaiting approval"

  // An approval card lives in the chat; never leave it behind another tab.
  useEffect(() => {
    if (awaitingApproval) setTab("chat")
  }, [awaitingApproval])

  // A new navlog while the pilot is in the chat: dot the two tabs that show it.
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab
  const previousNavlog = useRef(navlog)
  useEffect(() => {
    if (navlog !== null && navlog !== previousNavlog.current && activeTabRef.current === "chat") {
      setUnseen({ map: true, navlog: true })
    }
    previousNavlog.current = navlog
  }, [navlog])

  const selectTab = useCallback((next: PhoneTab): void => {
    setTab(next)
    if (next !== "chat") setUnseen((current) => ({ ...current, [next]: false }))
  }, [])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    menuButton.current?.focus()
  }, [])

  const showMemory = useCallback(() => {
    setDrawerOpen(false)
    setTab("chat")
    requestAnimationFrame(revealMemoryPanel)
  }, [])

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
    <ChatDock header={header} status={status} memory={memory} banner={banner} notices={notices}>
      {conversation}
    </ChatDock>
  )
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
        <div className="wb-root grid h-dvh grid-cols-[var(--wb-nav-width)_minmax(360px,34%)_minmax(0,1fr)] gap-[var(--wb-gutter)] p-[var(--wb-gutter)]">
          <SideNav
            brand="heading"
            rail={rail}
            memoryCount={memoryCount}
            onNewConversation={onNewConversation}
            onShowMemory={showMemory}
            className="wb-print-hide"
          />
          <div className="wb-print-hide flex min-h-0 min-w-0">{chat}</div>
          <div className="flex min-h-0 min-w-0 flex-col gap-[var(--wb-gutter)]">
            <div className="wb-panel wb-print-hide relative min-h-0 flex-1 overflow-hidden">
              {map}
              <div
                ref={stripRef}
                className="pointer-events-none absolute inset-x-3 top-3 z-10 flex justify-end *:pointer-events-auto"
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
        </div>
      </SheetControlContext.Provider>
    )
  }

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
            <Icon path="M4 7h16M4 12h16M4 17h16" />
          </button>
          <h1 className="min-w-0 truncate text-[15px]">
            <Wordmark />
          </h1>
          <button
            type="button"
            aria-label="New plan"
            disabled={!hydrated}
            onClick={onNewConversation}
            className="wb-focus wb-icon-button wb-icon-button-primary"
          >
            <Icon path="M12 5v14M5 12h14" />
          </button>
        </header>
        {/*
          All three panels stay mounted, stacked in one box, and the inactive
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
            inert={activeTab !== "chat"}
            className={`${PANEL_BOX} flex min-h-0 flex-col print:hidden ${activeTab === "chat" ? "" : "invisible"}`}
          >
            {chat}
          </div>
          <div
            role="tabpanel"
            id="wb-panel-map"
            aria-labelledby="wb-tab-map"
            inert={activeTab !== "map"}
            className={`wb-panel ${PANEL_BOX} overflow-hidden print:hidden ${activeTab === "map" ? "" : "invisible"}`}
          >
            {map}
            <div
              ref={stripRef}
              className="pointer-events-none absolute inset-x-2 top-2 z-10 *:pointer-events-auto"
            >
              <WeatherStrip brief={brief} layout="row" verdict={verdict} {...cruise} />
            </div>
          </div>
          {navlog ? (
            <div
              role="tabpanel"
              id="wb-panel-navlog"
              aria-labelledby="wb-tab-navlog"
              inert={activeTab !== "navlog"}
              className={`wb-sheet-wrap ${PANEL_BOX} overflow-auto ${activeTab === "navlog" ? "" : "invisible"}`}
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
                aria-selected={activeTab === item.id}
                aria-controls={`wb-panel-${item.id}`}
                disabled={item.id !== "chat" && navlog === null}
                className="wb-focus wb-tab"
                onClick={() => selectTab(item.id)}
              >
                <span className="relative">
                  <Icon path={item.icon} />
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
              onNewConversation={onNewConversation}
              onShowMemory={showMemory}
              onNavigate={closeDrawer}
              className="min-w-0 flex-1"
            />
          </Drawer>
        ) : null}
      </div>
    </SheetControlContext.Provider>
  )
}
