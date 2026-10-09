"use client"
import type { MouseEvent, ReactNode, Ref } from "react"
import { useHydrated } from "../lib/use-hydrated"
import { Icon } from "./icons"
import { primaryButton } from "./ui"
import { Wordmark } from "./Wordmark"

export interface SideNavCollapse {
  readonly collapsed: boolean
  readonly onToggle: () => void
  /** The sidebar's id, for the toggle's `aria-controls`. */
  readonly controls: string
}

export interface SideNavProps {
  /**
   * `heading`: the wordmark is the page's one h1 (desktop). `label`: plain
   * text, because on a phone the top row holds the h1 and this sits in the
   * drawer.
   */
  readonly brand: "heading" | "label"
  /** The thread list: `ThreadRail` with `showCreate={false}`. */
  readonly rail: ReactNode
  /** Memory candidates waiting for review (`MemoryPanel`'s `onCountChange`). */
  readonly memoryCount: number
  /** Whether Memory mode is on: the Memory item is a pressed toggle. */
  readonly memoryOpen: boolean
  readonly onNewConversation: () => void
  readonly onToggleMemory: () => void
  /** Called after any button inside is clicked: the phone's drawer closes on it. */
  readonly onNavigate?: () => void
  /** Desktop only: the collapse toggle and the 64px rail. The drawer has none. */
  readonly collapse?: SideNavCollapse
  readonly id?: string
  /** Where focus returns when Memory mode closes. */
  readonly memoryButtonRef?: Ref<HTMLButtonElement>
  /** Where focus goes when Memory mode closes and the Memory toggle is disabled. */
  readonly newPlanButtonRef?: Ref<HTMLButtonElement>
  readonly className?: string
}

/**
 * The left sidebar: the wordmark, New plan, the recent threads and Memory.
 * The desktop's first column (expanded, or collapsed to an icon rail) and the
 * phone's drawer (always expanded).
 *
 * Memory is a toggle for Memory mode, which replaces the map column with the
 * full candidate review. It is disabled only when nothing is waiting and the
 * mode is off, so the mode can always be left from here.
 *
 * "New plan" is disabled until hydration: it is in the server render, and a
 * click before its handler exists would be dropped.
 */
export function SideNav({
  brand,
  rail,
  memoryCount,
  memoryOpen,
  onNewConversation,
  onToggleMemory,
  onNavigate,
  collapse,
  id,
  memoryButtonRef,
  newPlanButtonRef,
  className = "",
}: SideNavProps) {
  const hydrated = useHydrated()
  const collapsed = collapse?.collapsed === true
  const memoryDisabled = memoryCount === 0 && !memoryOpen
  const onClick = (event: MouseEvent<HTMLElement>): void => {
    if (onNavigate === undefined) return
    if ((event.target as Element).closest("button") !== null) onNavigate()
  }
  const badge =
    memoryCount > 0 ? (
      <span className={`wb-badge${collapsed ? " absolute -right-1 -top-1" : ""}`}>
        {memoryCount}
        <span className="sr-only"> waiting for review</span>
      </span>
    ) : null
  const wordmark =
    brand === "heading" ? (
      <h1 className={collapsed ? "sr-only" : "min-w-0 truncate text-[15px]"}>
        <Wordmark />
      </h1>
    ) : (
      <p className="min-w-0 truncate text-[15px]">
        <Wordmark />
      </p>
    )
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar"
  const toggle = collapse ? (
    <button
      type="button"
      aria-label={toggleLabel}
      aria-expanded={!collapsed}
      aria-controls={collapse.controls}
      {...(collapsed ? { "data-tip": toggleLabel } : {})}
      onClick={collapse.onToggle}
      className="wb-focus wb-icon-button wb-icon-button-quiet wb-tip"
    >
      <Icon name="sidebar" />
    </button>
  ) : null

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegation only; every target inside is a real button with its own keyboard handling
    <aside
      {...(id === undefined ? {} : { id })}
      aria-label="Navigation"
      onClick={onClick}
      className={`wb-panel flex min-h-0 flex-col ${className}`}
    >
      {collapsed ? (
        <>
          <div className="wb-header-row justify-center">
            {wordmark}
            {toggle}
          </div>
          <div className="flex flex-col items-center gap-3 pt-1">
            <button
              ref={newPlanButtonRef}
              type="button"
              aria-label="New plan"
              data-tip="New plan"
              disabled={!hydrated}
              onClick={onNewConversation}
              className="wb-focus wb-icon-button wb-icon-button-primary wb-tip"
            >
              <Icon name="plus" />
            </button>
          </div>
          <div className="flex-1" />
          <div className="flex justify-center pb-3">
            <button
              ref={memoryButtonRef}
              type="button"
              aria-label="Memory"
              data-tip="Memory"
              aria-pressed={memoryOpen}
              disabled={memoryDisabled}
              onClick={onToggleMemory}
              className="wb-focus wb-icon-button wb-icon-button-quiet wb-tip disabled:opacity-60"
            >
              <Icon name="memory" />
              {badge}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="wb-header-row justify-between gap-2 pl-4 pr-2">
            {wordmark}
            {toggle}
          </div>
          <div className="px-2 pt-1">
            <button
              ref={newPlanButtonRef}
              type="button"
              disabled={!hydrated}
              onClick={onNewConversation}
              className={`${primaryButton("md")} inline-flex w-full items-center justify-center gap-1.5 disabled:opacity-60`}
            >
              <Icon name="plus" className="size-4" />
              New plan
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col pt-3">{rail}</div>
          <div className="px-2 pb-2">
            <button
              ref={memoryButtonRef}
              type="button"
              aria-pressed={memoryOpen}
              disabled={memoryDisabled}
              onClick={onToggleMemory}
              className="wb-focus wb-row flex w-full items-center justify-between gap-2 px-2 py-2 text-left text-[13px] font-medium text-wb-muted transition-colors hover:bg-wb-rail hover:text-wb-text aria-pressed:bg-wb-rail aria-pressed:text-wb-accent disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-wb-muted pointer-coarse:py-3"
            >
              <span className="flex items-center gap-2">
                <Icon name="memory" className="size-4" />
                <span>Memory</span>
              </span>
              {badge}
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
