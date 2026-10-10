"use client"
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import type { Navlog } from "../lib/navlog-types"
import { useHydrated } from "../lib/use-hydrated"
import { useMediaQuery } from "../lib/use-media-query"
import { useSidebarState } from "../lib/use-sidebar-state"
import type { WeatherBrief } from "../lib/weather-selectors"
import { ChatDock } from "./ChatDock"
import { Drawer } from "./Drawer"
import { Icon } from "./icons"
import { SideNav } from "./SideNav"
import { Wordmark } from "./Wordmark"

export interface MemoryControls {
  /** Whether Memory mode is showing the panel. */
  readonly open: boolean
  readonly onClose: () => void
}

/**
 * The compliance Workbench's layout. The props are the navlog shell's, so
 * `AppShell` is unchanged; this app has no navlog or weather, so it ignores
 * `navlog`, `brief` and `assistantBrief`.
 */
export interface WorkbenchLayoutProps {
  readonly navlog: Navlog | null
  readonly brief: WeatherBrief | null
  readonly assistantBrief: string
  readonly header: string
  readonly status?: string | undefined
  readonly rail: ReactNode
  readonly memory: (controls: MemoryControls) => ReactNode
  readonly memoryCount: number
  readonly banner?: ReactNode
  readonly notices?: ReactNode
  readonly chat: ReactNode
  readonly onNewConversation: () => void
}

/** Tailwind's `lg` breakpoint. */
const DESKTOP_QUERY = "(min-width: 1024px)"
/** What the reader shows before any citation is opened: the list of sources. */
const READER_HOME = "/sources"

/**
 * The page a plain click on a citation chip opens in the reader, or null to
 * let the browser handle the click (a modified click, or any other link).
 * Chips are the activity kit's `a.b4-chip`, linked to `/sources/<path>#<section>`.
 */
export function readerTarget(event: MouseEvent<HTMLElement>): string | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null
  }
  const chip = (event.target as Element | null)?.closest?.("a.b4-chip")
  const href = chip?.getAttribute("href")
  return href?.startsWith("/sources/") ? href : null
}

/**
 * Desktop: the sidenav, the chat, and the reader, where a citation chip opens
 * its source at the cited section. Memory mode covers the reader. Phone: the
 * chat alone, the sidenav in a drawer; a chip opens its page as a link would.
 */
export function WorkbenchLayout({
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
  const sidenavId = useId()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [reader, setReader] = useState(READER_HOME)
  const [sidebar, toggleSidebar] = useSidebarState()
  const memoryButton = useRef<HTMLButtonElement>(null)
  const newPlanButton = useRef<HTMLButtonElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (isDesktop) setDrawerOpen(false)
  }, [isDesktop])

  const closeMemory = useCallback(() => {
    setMemoryOpen(false)
    requestAnimationFrame(() => {
      const target = [memoryButton.current, newPlanButton.current, menuButton.current].find(
        (button): button is HTMLButtonElement => button?.isConnected === true && !button.disabled,
      )
      target?.focus()
    })
  }, [])
  const toggleMemory = useCallback(() => {
    if (memoryOpen) closeMemory()
    else {
      setDrawerOpen(false)
      setMemoryOpen(true)
    }
  }, [memoryOpen, closeMemory])
  const newConversation = useCallback(() => {
    setMemoryOpen(false)
    setReader(READER_HOME)
    onNewConversation()
  }, [onNewConversation])
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    menuButton.current?.focus()
  }, [])
  const onMemoryKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && memoryOpen) closeMemory()
  }
  // Capture phase, so the chip's own `target="_blank"` never opens a tab.
  const openCitation = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = readerTarget(event)
    if (target === null) return
    event.preventDefault()
    setMemoryOpen(false)
    setReader(target)
  }, [])

  const chat = (
    <ChatDock header={header} status={status} banner={banner} notices={notices}>
      {conversation}
    </ChatDock>
  )
  const memoryPanel = memory({ open: memoryOpen, onClose: closeMemory })

  if (isDesktop) {
    return (
      <div
        data-sidebar={sidebar}
        className="wb-root grid h-dvh overflow-clip grid-cols-[var(--wb-nav-width)_minmax(420px,46%)_minmax(0,1fr)] gap-[var(--wb-gutter)] p-[var(--wb-gutter)]"
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
        {/* A keyboard activation of a chip is a click too, so this sees both. */}
        <div className="flex min-h-0 min-w-0" onClickCapture={openCitation}>
          {chat}
        </div>
        {/*
          Clipped, not scrollable: a citation's `#section` scrolls the reader's
          own page to it, and a browser also scrolls every scrollable ancestor
          of the iframe to bring it into view, which would shift the shell.
        */}
        <div className="relative min-h-0 min-w-0 overflow-clip">
          <section
            aria-label="Source"
            inert={memoryOpen}
            className={`wb-panel h-full overflow-hidden ${memoryOpen ? "invisible" : ""}`}
          >
            <iframe title="Source" src={reader} className="h-full w-full border-0" />
          </section>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape is handled for the whole column; its controls are real buttons */}
          <div
            data-memory-column=""
            inert={!memoryOpen}
            onKeyDown={onMemoryKeyDown}
            className={`absolute inset-0 ${memoryOpen ? "" : "invisible"}`}
          >
            {memoryPanel}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="wb-root flex h-dvh flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-[max(8px,env(safe-area-inset-top))]">
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
        <span className="w-9" />
      </header>
      <div className="relative min-h-0 flex-1">
        <div
          inert={memoryOpen}
          className={`absolute inset-x-2 top-0 bottom-2 flex min-h-0 flex-col ${memoryOpen ? "invisible" : ""}`}
        >
          {chat}
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape is handled for the whole panel; its controls are real buttons */}
        <div
          data-memory-column=""
          inert={!memoryOpen}
          onKeyDown={onMemoryKeyDown}
          className={`absolute inset-x-2 top-0 bottom-2 flex min-h-0 flex-col ${memoryOpen ? "" : "invisible"}`}
        >
          {memoryPanel}
        </div>
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
  )
}
