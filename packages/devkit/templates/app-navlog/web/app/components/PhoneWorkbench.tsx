"use client"
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useHydrated } from "../lib/use-hydrated"
import { Drawer } from "./Drawer"
import { Icon, type IconName } from "./icons"
import { NavlogSheet } from "./NavlogSheet"
import { SideNav } from "./SideNav"
import { type SheetControl, SheetControlContext } from "./sheet-control"
import { Wordmark } from "./Wordmark"
import type { WorkbenchViewProps } from "./WorkbenchLayout"

export interface PhoneWorkbenchProps extends WorkbenchViewProps {
  /** An approval card is waiting in the chat: the Chat tab must stay in view. */
  readonly awaitingApproval: boolean
}

/** Where a panel sits: all of them stack in one box, inside the gutter. */
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
 * The phone workbench: a top row (menu, wordmark, New plan), one full-screen
 * panel, and a bottom tab bar (Chat, Map, Navlog); the sidenav opens as a
 * drawer. The Map tab holds the route bar over the map.
 *
 * Memory mode shows the memory review as a fourth stacked panel, with no tab
 * selected; any tab leaves it. A pending approval keeps the Chat tab in view:
 * it switches back to Chat, leaves Memory mode, and keeps Memory from opening
 * over it. A new navlog that lands while the pilot is in the chat dots the
 * Map and Navlog tabs until each is visited. `openSheet` (the step views'
 * "See the navlog sheet") selects the Navlog tab on its Legs.
 *
 * `wb-root`, `wb-sheet-wrap` and `wb-print-hide` are what the print rules in
 * `theme.css` use so the sheet prints alone, in the page flow.
 */
export function PhoneWorkbench({
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
  awaitingApproval,
}: PhoneWorkbenchProps) {
  const hydrated = useHydrated()
  const drawerId = useId()
  const menuButton = useRef<HTMLButtonElement>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [tab, setTab] = useState<PhoneTab>("chat")
  const [unseen, setUnseen] = useState<{ readonly map: boolean; readonly navlog: boolean }>({
    map: false,
    navlog: false,
  })
  // No navlog, nothing on the Navlog tab: a thread switch must not leave it
  // selected. The Map tab holds the route bar, so it works before a plan.
  const activeTab: PhoneTab = tab === "navlog" && navlog === null ? "chat" : tab

  /**
   * Leaves Memory mode and, a frame later (after the re-render), focuses the
   * menu button that opens the drawer: the drawer's Memory toggle and New plan
   * are gone with it.
   */
  const closeMemory = useCallback(() => {
    onMemoryOpenChange(false)
    requestAnimationFrame(() => {
      const button = menuButton.current
      if (button?.isConnected === true && !button.disabled) button.focus()
    })
  }, [onMemoryOpenChange])

  // An approval card lives in the chat; never leave it behind another tab.
  useEffect(() => {
    if (awaitingApproval) setTab("chat")
  }, [awaitingApproval])
  // The chat is hidden while Memory mode shows; the card must be seen.
  useEffect(() => {
    if (awaitingApproval && memoryOpen) closeMemory()
  }, [awaitingApproval, memoryOpen, closeMemory])

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

  const selectTab = useCallback(
    (next: PhoneTab): void => {
      setTab(next)
      onMemoryOpenChange(false)
      if (next !== "chat") setUnseen((current) => ({ ...current, [next]: false }))
    },
    [onMemoryOpenChange],
  )

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    menuButton.current?.focus()
  }, [])

  const toggleMemory = useCallback(() => {
    if (memoryOpen) {
      closeMemory()
      return
    }
    setDrawerOpen(false)
    // The mode would hide the chat, and a pending approval card must stay in view.
    if (awaitingApproval) return
    onMemoryOpenChange(true)
  }, [memoryOpen, closeMemory, awaitingApproval, onMemoryOpenChange])

  // Escape anywhere inside the memory panel leaves the mode.
  const onMemoryKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && memoryOpen) closeMemory()
  }

  const { onTabChange } = sheet
  const sheetControl = useMemo<SheetControl>(
    () => ({
      openSheet: () => {
        selectTab("navlog")
        onTabChange("legs")
      },
    }),
    [selectTab, onTabChange],
  )

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
            onClick={onNewConversation}
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
            {/* No grid on a phone, so no leg is selected to light. */}
            {renderMap(null)}
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
                planningAnswer={sheet.planningAnswer}
                weatherBrief={sheet.weatherBrief}
                stations={sheet.stations}
                open={true}
                onToggle={() => {}}
                tab={sheet.tab}
                onTabChange={onTabChange}
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
            {memory({ open: memoryOpen, onClose: closeMemory })}
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
              onNewConversation={onNewConversation}
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
