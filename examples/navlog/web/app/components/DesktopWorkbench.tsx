"use client"
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { pairIndexOf } from "../lib/route-geometry"
import { type SheetControl, SheetControlContext } from "../lib/sheet-control"
import { useSidebarState } from "../lib/use-sidebar-state"
import { NavlogSheet } from "./NavlogSheet"
import { SideNav } from "./SideNav"
import type { WorkbenchViewProps } from "./WorkbenchLayout"

/**
 * The desktop workbench (`lg` and up): a grey canvas with three docked
 * columns and no top bar. The sidenav (expanded, or collapsed to a 64px icon
 * rail, remembered per browser), the chat, and the map stacked over the
 * navlog sheet, with the route bar floating across the top of the map.
 *
 * Memory mode covers the map column with the memory review. The sheet opens
 * and closes under the map; the leg selected in its grid lights on the map.
 * `openSheet` (the step views' "See the navlog sheet") opens the sheet on its
 * Legs tab.
 *
 * `wb-root`, `wb-sheet-wrap` and `wb-print-hide` are what the print rules in
 * `theme.css` use so the sheet prints alone, in the page flow.
 */
export function DesktopWorkbench({
  navlog,
  sheet,
  rail,
  memoryCount,
  memory,
  memoryOpen,
  onMemoryOpenChange,
  onNewConversation,
  chat,
  renderMap,
  routeBar,
  markerPanel,
}: WorkbenchViewProps) {
  const [sidebar, toggleSidebar] = useSidebarState()
  const sidenavId = useId()
  const memoryButton = useRef<HTMLButtonElement>(null)
  const newPlanButton = useRef<HTMLButtonElement>(null)
  const [sheetOpen, setSheetOpen] = useState(true)
  // The leg selected in the grid, lit on the map.
  const [selectedLeg, setSelectedLeg] = useState<number | null>(null)

  // A new navlog (a replan) has new legs: the old selection means nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the navlog is the trigger, not an input
  useEffect(() => {
    setSelectedLeg(null)
  }, [navlog])

  /**
   * Leaves Memory mode and, a frame later (after the re-render), focuses the
   * Memory toggle that opened it, unless closing disabled it (nothing left to
   * review); then the sidebar's New plan.
   */
  const closeMemory = useCallback(() => {
    onMemoryOpenChange(false)
    requestAnimationFrame(() => {
      const target = [memoryButton.current, newPlanButton.current].find(
        (button): button is HTMLButtonElement => button?.isConnected === true && !button.disabled,
      )
      target?.focus()
    })
  }, [onMemoryOpenChange])

  const toggleMemory = useCallback(() => {
    if (memoryOpen) closeMemory()
    else onMemoryOpenChange(true)
  }, [memoryOpen, closeMemory, onMemoryOpenChange])

  // Escape anywhere inside the memory column leaves the mode.
  const onMemoryKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && memoryOpen) closeMemory()
  }

  const { onTabChange } = sheet
  const sheetControl = useMemo<SheetControl>(
    () => ({
      openSheet: () => {
        setSheetOpen(true)
        onTabChange("legs")
      },
    }),
    [onTabChange],
  )

  const highlightedLeg = navlog && selectedLeg !== null ? pairIndexOf(navlog, selectedLeg) : null

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
          onNewConversation={onNewConversation}
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
              {renderMap(highlightedLeg)}
              {routeBar}
              {markerPanel}
            </div>
            {navlog ? (
              <div className="wb-sheet-wrap min-h-0 shrink-0">
                <NavlogSheet
                  navlog={navlog}
                  planningAnswer={sheet.planningAnswer}
                  forecast={sheet.forecast}
                  stations={sheet.stations}
                  open={sheetOpen}
                  onToggle={() => setSheetOpen((value) => !value)}
                  tab={sheet.tab}
                  onTabChange={onTabChange}
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
            {memory({ open: memoryOpen, onClose: closeMemory })}
          </div>
        </div>
      </div>
    </SheetControlContext.Provider>
  )
}
