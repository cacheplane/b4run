"use client"
import dynamic from "next/dynamic"
import { type ReactNode, useMemo, useState } from "react"
import type { Navlog } from "../lib/navlog-types"
import { pairIndexOf, routeGeometry } from "../lib/route-geometry"
import { useMediaQuery } from "../lib/use-media-query"
import type { FlightCategory, WeatherBrief } from "../lib/weather-selectors"
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
}

/** Room the map leaves for the floating surfaces when it fits the route, in pixels. */
const DOCK_PAD = 420
const SHEET_PAD = 140
const STRIP_PAD = 90
/** The phone sheet is 58vh tall; this keeps the route above it on a typical phone. */
const PHONE_SHEET_PAD = 440
/** Tailwind's `md` breakpoint. */
const DESKTOP_QUERY = "(min-width: 768px)"

/**
 * Map full-bleed; the dock floats left, the weather strip top-right, the
 * navlog sheet along the bottom. Under `md` the dock and the sheet become one
 * bottom sheet with Chat and Navlog tabs.
 *
 * Only the layout that applies is rendered, not both hidden by CSS: the dock
 * holds `Transcript` and `Composer`, and two copies would mean two `<main>`
 * elements, two sets of CopilotKit subscriptions and two composers.
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
}: WorkbenchLayoutProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const [sheetOpen, setSheetOpen] = useState(true)
  const [tab, setTab] = useState<"navlog" | "chat">("chat")
  const [hoveredLeg, setHoveredLeg] = useState<number | null>(null)
  const geometry = useMemo(() => (navlog ? routeGeometry(navlog) : null), [navlog])
  const categories = useMemo(() => {
    const out: Record<string, FlightCategory> = {}
    for (const airport of brief?.airports ?? []) {
      out[airport.id] = airport.atEta !== "UNKNOWN" ? airport.atEta : airport.now
    }
    return out
  }, [brief])
  const padding = useMemo(
    () =>
      isDesktop
        ? { left: DOCK_PAD, bottom: navlog ? SHEET_PAD : 40, top: STRIP_PAD }
        : { left: 24, bottom: PHONE_SHEET_PAD, top: STRIP_PAD },
    [isDesktop, navlog],
  )
  const highlightedLeg = navlog && hoveredLeg !== null ? pairIndexOf(navlog, hoveredLeg) : null

  const chat = (
    <ChatDock header={header} status={status} rail={rail} memory={memory} composer={composer}>
      {dock}
    </ChatDock>
  )

  return (
    <div className="relative h-dvh overflow-hidden">
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
            <div className="absolute bottom-[var(--wb-gutter)] left-[calc(var(--wb-dock-width)+2*var(--wb-gutter))] right-[var(--wb-gutter)] z-10">
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
        <div className="absolute inset-x-0 bottom-0 z-10 flex h-[58vh] flex-col">
          <div className="absolute inset-x-3 top-[-52px]">
            <WeatherStrip brief={brief} />
          </div>
          <div className="wb-panel flex min-h-0 flex-1 flex-col rounded-b-none pb-[env(safe-area-inset-bottom)]">
            <div className="wb-sheet-tabs flex gap-1 px-3 pt-1.5" role="tablist">
              <button
                type="button"
                role="tab"
                id="wb-tab-chat"
                aria-selected={tab === "chat"}
                aria-controls="wb-panel-chat"
                className="wb-focus px-3 py-1.5 text-[13px] aria-selected:border-b-2 aria-selected:border-wb-accent-from"
                onClick={() => setTab("chat")}
              >
                Chat
              </button>
              <button
                type="button"
                role="tab"
                id="wb-tab-navlog"
                aria-selected={tab === "navlog"}
                aria-controls="wb-panel-navlog"
                disabled={navlog === null}
                className="wb-focus px-3 py-1.5 text-[13px] disabled:opacity-50 aria-selected:border-b-2 aria-selected:border-wb-accent-from"
                onClick={() => setTab("navlog")}
              >
                Navlog
              </button>
            </div>
            {/*
              The chat stays mounted behind the Navlog tab (hidden, not
              unmounted), so a switch keeps the transcript's scroll position,
              the composer's draft and any parked approval card.
            */}
            <div
              role="tabpanel"
              id="wb-panel-chat"
              aria-labelledby="wb-tab-chat"
              hidden={tab !== "chat" && navlog !== null}
              className="flex min-h-0 flex-1 flex-col"
            >
              {chat}
            </div>
            {tab === "navlog" && navlog ? (
              <div
                role="tabpanel"
                id="wb-panel-navlog"
                aria-labelledby="wb-tab-navlog"
                className="min-h-0 flex-1 overflow-auto"
              >
                <NavlogSheet
                  navlog={navlog}
                  brief={assistantBrief}
                  open={true}
                  onToggle={() => {}}
                  variant="cards"
                />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
