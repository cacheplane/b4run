"use client"
import dynamic from "next/dynamic"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import type { Navlog } from "../lib/navlog-types"
import { pairIndexOf, routeGeometry } from "../lib/route-geometry"
import { useMediaQuery } from "../lib/use-media-query"
import { type FlightCategory, type WeatherBrief, worstCategory } from "../lib/weather-selectors"
import { ChatDock } from "./ChatDock"
import { NavlogSheet } from "./NavlogSheet"
import { WeatherStrip } from "./WeatherStrip"

const RouteMap = dynamic(() => import("./RouteMap").then((m) => m.RouteMap), { ssr: false })

export interface WorkbenchLayoutProps {
  readonly navlog: Navlog | null
  readonly brief: WeatherBrief | null
  /** The assistant's latest prose, shown in the sheet as the brief. */
  readonly assistantBrief: string
  readonly header: string
  readonly status?: string | undefined
  readonly rail: ReactNode
  readonly memory: ReactNode
  readonly dock: ReactNode
  readonly composer: ReactNode
  readonly onNewConversation: () => void
}

/** Room the map leaves for the floating surfaces when it fits the route, in pixels. */
const DOCK_PAD = 420
const STRIP_PAD = 90
/** The collapsed sheet: one line of totals plus the gutter. */
const SHEET_COLLAPSED_PAD = 140
/** Matches `--wb-sheet-max` (46vh), the open sheet's height cap. */
const SHEET_OPEN_SHARE = 0.46
/** The phone's bottom sheet is 58vh, with the weather row above it. */
const PHONE_SHEET_SHARE = 0.58
const PHONE_STRIP_PAD = 60
/** Tailwind's `md` breakpoint. */
const DESKTOP_QUERY = "(min-width: 768px)"

/** Read at render, not tracked: the fit is a starting view, and the pilot can pan. */
const viewportHeight = (): number => (typeof window === "undefined" ? 800 : window.innerHeight)

/**
 * Map full-bleed; the dock floats left, the weather strip top-right, the
 * navlog sheet along the bottom. Under `md` the dock and the sheet become one
 * bottom sheet with Chat and Navlog tabs.
 *
 * Only the layout that applies is rendered, not both hidden by CSS: the dock
 * holds `Transcript` and `Composer`, and two copies would mean two `<main>`
 * elements, two sets of CopilotKit subscriptions and two composers.
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
  dock,
  composer,
  onNewConversation,
}: WorkbenchLayoutProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const [sheetOpen, setSheetOpen] = useState(true)
  const [tab, setTab] = useState<"navlog" | "chat">("chat")
  const [hoveredLeg, setHoveredLeg] = useState<number | null>(null)
  // No navlog, no Navlog tab: a thread switch must not leave an empty tab selected.
  const activeTab = navlog ? tab : "chat"
  const awaitingApproval = status === "awaiting approval"

  // An approval card lives in the chat; never leave it behind the Navlog tab.
  useEffect(() => {
    if (awaitingApproval) setTab("chat")
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
        top: 24,
        bottom: Math.round(viewportHeight() * PHONE_SHEET_SHARE) + PHONE_STRIP_PAD,
      }
    }
    const bottom =
      navlog === null
        ? 40
        : sheetOpen
          ? Math.round(viewportHeight() * SHEET_OPEN_SHARE) + 32
          : SHEET_COLLAPSED_PAD
    return { left: DOCK_PAD, top: STRIP_PAD, bottom }
  }, [isDesktop, navlog, sheetOpen])
  const highlightedLeg = navlog && hoveredLeg !== null ? pairIndexOf(navlog, hoveredLeg) : null

  const chat = (
    <ChatDock
      header={header}
      status={status}
      rail={rail}
      memory={memory}
      composer={composer}
      onNewConversation={onNewConversation}
    >
      {dock}
    </ChatDock>
  )

  return (
    <div className="wb-root relative h-dvh overflow-hidden">
      <RouteMap
        geometry={geometry}
        categories={categories}
        highlightedLeg={highlightedLeg}
        padding={padding}
      />
      {isDesktop ? (
        <>
          <div className="pointer-events-none absolute left-[calc(var(--wb-dock-width)+2*var(--wb-gutter))] right-[var(--wb-gutter)] top-[var(--wb-gutter)] z-10 flex justify-end *:pointer-events-auto">
            <WeatherStrip brief={brief} />
          </div>
          <div className="absolute bottom-[var(--wb-gutter)] left-[var(--wb-gutter)] top-[var(--wb-gutter)] z-10 flex w-[var(--wb-dock-width)]">
            {chat}
          </div>
          {/*
            Beside the dock rather than under it: the sheet opens to
            --wb-sheet-max, and spanning the full width would cover the
            dock's composer whenever it is open.
          */}
          {navlog ? (
            <div className="wb-sheet-wrap absolute bottom-[var(--wb-gutter)] left-[calc(var(--wb-dock-width)+2*var(--wb-gutter))] right-[var(--wb-gutter)] z-10">
              <NavlogSheet
                navlog={navlog}
                brief={assistantBrief}
                open={sheetOpen}
                onToggle={() => setSheetOpen((value) => !value)}
                onHoverLeg={setHoveredLeg}
              />
            </div>
          ) : null}
        </>
      ) : (
        <div className="wb-sheet-wrap absolute inset-x-0 bottom-0 z-10 flex h-[58vh] flex-col">
          <div className="absolute inset-x-3 top-[-52px]">
            <WeatherStrip brief={brief} layout="row" />
          </div>
          <div className="wb-panel flex min-h-0 flex-1 flex-col rounded-b-none pb-[env(safe-area-inset-bottom)]">
            <div className="wb-sheet-tabs flex gap-1 px-3 pt-1" role="tablist">
              <button
                type="button"
                role="tab"
                id="wb-tab-chat"
                aria-selected={activeTab === "chat"}
                aria-controls="wb-panel-chat"
                className="wb-focus min-h-11 px-3 text-[13px] aria-selected:border-b-2 aria-selected:border-wb-accent-from"
                onClick={() => setTab("chat")}
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
                className="wb-focus min-h-11 px-3 text-[13px] disabled:opacity-50 aria-selected:border-b-2 aria-selected:border-wb-accent-from"
                onClick={() => setTab("navlog")}
              >
                Navlog
              </button>
            </div>
            {/*
              Both panels stay mounted and the inactive one is hidden with a
              class, not unmounted: a switch keeps the transcript's scroll
              position, the composer's draft and any parked approval card, and
              the navlog panel still prints (`print:block`) from the Chat tab.
            */}
            <div
              role="tabpanel"
              id="wb-panel-chat"
              aria-labelledby="wb-tab-chat"
              className={`min-h-0 flex-1 flex-col print:hidden ${
                activeTab === "chat" ? "flex" : "hidden"
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
                  activeTab === "navlog" ? "" : "hidden print:block"
                }`}
              >
                <NavlogSheet
                  navlog={navlog}
                  brief={assistantBrief}
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
  )
}
