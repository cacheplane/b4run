"use client"
import dynamic from "next/dynamic"
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { Navlog } from "../lib/navlog-types"
import { pairIndexOf, routeGeometry } from "../lib/route-geometry"
import { useMediaQuery } from "../lib/use-media-query"
import { resolveVerdict } from "../lib/verdict"
import { type FlightCategory, type WeatherBrief, worstCategory } from "../lib/weather-selectors"
import { ChatDock } from "./ChatDock"
import { NavlogSheet } from "./NavlogSheet"
import { type SheetControl, SheetControlContext } from "./sheet-control"
import { WeatherStrip } from "./WeatherStrip"

const RouteMap = dynamic(() => import("./RouteMap").then((m) => m.RouteMap), { ssr: false })

export interface WorkbenchLayoutProps {
  readonly navlog: Navlog | null
  readonly brief: WeatherBrief | null
  /** The planning answer of the turn that produced the navlog, shown in the sheet. */
  readonly assistantBrief: string
  readonly header: string
  readonly status?: string | undefined
  readonly rail: ReactNode
  readonly memory: ReactNode
  /** The dock's failure banner (`RunError`), or nothing. */
  readonly banner?: ReactNode
  /** The dock's content-parts-dropped notices, or nothing. */
  readonly notices?: ReactNode
  /** The conversation (`NavlogChat`): messages and input. */
  readonly chat: ReactNode
  readonly onNewConversation: () => void
}

/**
 * Room the map leaves for the floating surfaces when it fits the route, in
 * pixels: the dock on the left (desktop), the weather strip along the top,
 * the sheet along the bottom.
 */
const DOCK_PAD = 470
const STRIP_PAD = 90
const PHONE_TOP_PAD = 32
/** The collapsed sheet: one line of totals plus the gutter. */
const SHEET_COLLAPSED_PAD = 140
/** Matches `--wb-sheet-max` (46vh), the open sheet's height cap. */
const SHEET_OPEN_SHARE = 0.46
/** The phone's bottom sheet is 58vh, with the weather row above it. */
const PHONE_SHEET_SHARE = 0.58
const PHONE_STRIP_PAD = 60
/** The phone's peeking sheet: the grip and the tabs. */
const PHONE_PEEK_PAD = 120
/** Tailwind's `md` breakpoint. */
const DESKTOP_QUERY = "(min-width: 768px)"

/** Read at render, not tracked: the fit is a starting view, and the pilot can pan. */
const viewportHeight = (): number => (typeof window === "undefined" ? 800 : window.innerHeight)

/**
 * A floating surface's height, tracked. The bottom one lifts Leaflet's
 * bottom-right controls (zoom, and the attribution the tile policy requires)
 * just above the sheet; the strip's tells the route fit how much room to
 * leave at the top. Re-attached after every render because which element the
 * ref points at changes with the layout; an unchanged height is a no-op.
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
 * Map full-bleed; the dock floats left, the weather strip top-right, the
 * navlog sheet along the bottom. Under `md` the dock and the sheet become one
 * bottom sheet with Chat and Navlog tabs, which can drop to a peek to show
 * more map.
 *
 * Only the layout that applies is rendered, not both hidden by CSS: the dock
 * holds the chat, and two copies would mean two `<main>` elements, two
 * `CopilotChat`s connecting the same thread and two inputs.
 *
 * Provides `SheetControlContext`, so a step view inside the chat ("See the
 * navlog sheet") can bring the sheet into view: on a desktop it opens the
 * sheet, on a phone it selects the Navlog tab.
 *
 * `wb-root` and `wb-sheet-wrap` are what the print rules in `theme.css` flatten
 * so the sheet prints in the page flow instead of clipped to the viewport.
 */
export function WorkbenchLayout({
  navlog,
  brief,
  assistantBrief,
  header,
  status,
  rail,
  memory,
  banner,
  notices,
  chat: conversation,
  onNewConversation,
}: WorkbenchLayoutProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const [sheetOpen, setSheetOpen] = useState(true)
  const [phoneExpanded, setPhoneExpanded] = useState(true)
  const [tab, setTab] = useState<"navlog" | "chat">("chat")
  const [hoveredLeg, setHoveredLeg] = useState<number | null>(null)
  const [bottomRef, bottomInset] = useMeasuredHeight()
  const [stripRef, stripHeight] = useMeasuredHeight()
  // No navlog, no Navlog tab: a thread switch must not leave an empty tab selected.
  const activeTab = navlog ? tab : "chat"
  const awaitingApproval = status === "awaiting approval"

  // An approval card lives in the chat; never leave it behind the Navlog tab
  // or a peeking sheet.
  useEffect(() => {
    if (awaitingApproval) {
      setTab("chat")
      setPhoneExpanded(true)
    }
  }, [awaitingApproval])

  const geometry = useMemo(() => (navlog ? routeGeometry(navlog) : null), [navlog])
  const categories = useMemo(() => {
    const out: Record<string, FlightCategory> = {}
    for (const airport of brief?.airports ?? []) out[airport.id] = worstCategory(airport)
    return out
  }, [brief])
  const padding = useMemo(() => {
    if (!isDesktop) {
      return {
        left: 24,
        top: PHONE_TOP_PAD,
        bottom: phoneExpanded
          ? Math.round(viewportHeight() * PHONE_SHEET_SHARE) + PHONE_STRIP_PAD
          : PHONE_PEEK_PAD + PHONE_STRIP_PAD,
      }
    }
    const bottom =
      navlog === null
        ? 40
        : sheetOpen
          ? Math.round(viewportHeight() * SHEET_OPEN_SHARE) + 32
          : SHEET_COLLAPSED_PAD
    return { left: DOCK_PAD, top: Math.max(STRIP_PAD, stripHeight + 40), bottom }
  }, [isDesktop, navlog, sheetOpen, phoneExpanded, stripHeight])
  const highlightedLeg = navlog && hoveredLeg !== null ? pairIndexOf(navlog, hoveredLeg) : null
  const cruise = navlog ? { cruiseFt: navlog.altitudeFt } : {}
  // The same inputs the sheet resolves its verdict from, so the strip's pill
  // and the sheet's card always show the same level.
  const verdict = useMemo(
    () => resolveVerdict({ weather: brief, answer: assistantBrief, navlog }),
    [brief, assistantBrief, navlog],
  )

  const chat = (
    <ChatDock
      header={header}
      status={status}
      rail={rail}
      memory={memory}
      banner={banner}
      notices={notices}
      onNewConversation={onNewConversation}
    >
      {conversation}
    </ChatDock>
  )

  const selectTab = (next: "navlog" | "chat"): void => {
    setTab(next)
    setPhoneExpanded(true)
  }

  // Read the layout at the click, through the memo's dependency: a desktop
  // opens the sheet beside the dock, a phone switches to the Navlog tab.
  const sheetControl = useMemo<SheetControl>(
    () => ({
      openSheet: () => {
        if (isDesktop) {
          setSheetOpen(true)
        } else {
          setTab("navlog")
          setPhoneExpanded(true)
        }
      },
    }),
    [isDesktop],
  )

  return (
    <SheetControlContext.Provider value={sheetControl}>
      <div
        className="wb-root relative h-dvh overflow-hidden"
        style={{ "--wb-map-inset-bottom": `${bottomInset}px` } as CSSProperties}
      >
        <RouteMap
          geometry={geometry}
          categories={categories}
          highlightedLeg={highlightedLeg}
          padding={padding}
        />
        {isDesktop ? (
          <>
            <div
              ref={stripRef}
              className="pointer-events-none absolute left-[calc(var(--wb-dock-width)+2*var(--wb-gutter))] right-[var(--wb-gutter)] top-[var(--wb-gutter)] z-10 flex justify-end *:pointer-events-auto"
            >
              <WeatherStrip brief={brief} verdict={verdict} {...cruise} />
            </div>
            <div className="absolute bottom-[var(--wb-gutter)] left-[var(--wb-gutter)] top-[var(--wb-gutter)] z-10 flex w-[var(--wb-dock-width)]">
              {chat}
            </div>
            {/*
            Beside the dock rather than under it: the sheet opens to
            --wb-sheet-max, and spanning the full width would cover the
            dock's input whenever it is open.
          */}
            {navlog ? (
              <div
                ref={bottomRef}
                className="wb-sheet-wrap absolute bottom-[var(--wb-gutter)] left-[calc(var(--wb-dock-width)+2*var(--wb-gutter))] right-[var(--wb-gutter)] z-10"
              >
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
          </>
        ) : (
          <div
            ref={bottomRef}
            className="wb-sheet-wrap pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2"
          >
            <div className="px-3">
              <WeatherStrip brief={brief} layout="row" verdict={verdict} {...cruise} />
            </div>
            <div
              className={`wb-panel wb-phone-sheet pointer-events-auto flex flex-col rounded-b-none pb-[env(safe-area-inset-bottom)] ${
                phoneExpanded ? "h-[58vh]" : ""
              }`}
            >
              <button
                type="button"
                className="wb-focus wb-sheet-grip flex h-8 w-full shrink-0 items-center justify-center"
                aria-expanded={phoneExpanded}
                aria-label={phoneExpanded ? "Lower the panel to show the map" : "Raise the panel"}
                onClick={() => setPhoneExpanded((value) => !value)}
              >
                <span className="h-1 w-10 rounded-full bg-wb-border" />
              </button>
              <div
                className="wb-sheet-tabs flex gap-1 border-b border-wb-border px-3"
                role="tablist"
              >
                <button
                  type="button"
                  role="tab"
                  id="wb-tab-chat"
                  aria-selected={activeTab === "chat"}
                  aria-controls="wb-panel-chat"
                  className="wb-focus wb-tab"
                  onClick={() => selectTab("chat")}
                >
                  Chat
                </button>
                <button
                  type="button"
                  role="tab"
                  id="wb-tab-navlog"
                  aria-selected={activeTab === "navlog"}
                  aria-controls="wb-panel-navlog"
                  disabled={navlog === null}
                  className="wb-focus wb-tab"
                  onClick={() => selectTab("navlog")}
                >
                  Navlog
                </button>
              </div>
              {/*
              Both panels stay mounted and the inactive one is hidden with a
              class, not unmounted: a switch keeps the chat's scroll
              position, the input's draft and any parked approval card, and
              the navlog panel still prints (`print:block`) from the Chat tab.
              A lowered (peeking) sheet hides both the same way.
            */}
              <div
                role="tabpanel"
                id="wb-panel-chat"
                aria-labelledby="wb-tab-chat"
                className={`min-h-0 flex-1 flex-col print:hidden ${
                  activeTab === "chat" && phoneExpanded ? "flex" : "hidden"
                }`}
              >
                {chat}
              </div>
              {navlog ? (
                <div
                  role="tabpanel"
                  id="wb-panel-navlog"
                  aria-labelledby="wb-tab-navlog"
                  className={`min-h-0 flex-1 overflow-auto ${
                    activeTab === "navlog" && phoneExpanded ? "" : "hidden print:block"
                  }`}
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
          </div>
        )}
      </div>
    </SheetControlContext.Provider>
  )
}
