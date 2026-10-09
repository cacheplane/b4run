"use client"
import type { MouseEvent, ReactNode } from "react"
import { useHydrated } from "../lib/use-hydrated"
import { primaryButton } from "./ui"
import { Wordmark } from "./Wordmark"

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
  readonly onNewConversation: () => void
  /** Brings the inline memory panel into view (`revealMemoryPanel`). */
  readonly onShowMemory: () => void
  /** Called after any button inside is clicked: the phone's drawer closes on it. */
  readonly onNavigate?: () => void
  readonly className?: string
}

/**
 * The left sidenav: the wordmark, "New plan", the recent threads and Memory.
 * The same component is the desktop's first column and the phone's drawer.
 *
 * Memory is a count and a shortcut, not a second home for the panel: the
 * panel stays above the conversation (see `memory-anchor.ts`). With nothing
 * waiting the item is disabled rather than hidden, so the nav does not jump.
 *
 * "New plan" is disabled until hydration for the reason the dock's header
 * buttons were: it is in the server render, and a click before its handler
 * exists is dropped.
 */
export function SideNav({
  brand,
  rail,
  memoryCount,
  onNewConversation,
  onShowMemory,
  onNavigate,
  className = "",
}: SideNavProps) {
  const hydrated = useHydrated()
  const onClick = (event: MouseEvent<HTMLElement>): void => {
    if (onNavigate === undefined) return
    if ((event.target as Element).closest("button") !== null) onNavigate()
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegation only; every target inside is a real button with its own keyboard handling
    <aside
      aria-label="Navigation"
      onClick={onClick}
      className={`wb-panel flex min-h-0 flex-col gap-3 p-2 ${className}`}
    >
      {brand === "heading" ? (
        <h1 className="px-2 pt-1.5 text-[15px]">
          <Wordmark />
        </h1>
      ) : (
        <p className="px-2 pt-1.5 text-[15px]">
          <Wordmark />
        </p>
      )}
      <button
        type="button"
        disabled={!hydrated}
        onClick={onNewConversation}
        className={`${primaryButton("md")} inline-flex items-center justify-center gap-1.5 disabled:opacity-60`}
      >
        <span aria-hidden="true">+</span>
        New plan
      </button>
      <div className="flex min-h-0 flex-1 flex-col">{rail}</div>
      <button
        type="button"
        disabled={memoryCount === 0}
        onClick={onShowMemory}
        className="wb-focus flex items-center justify-between rounded-full px-3 py-2 text-left text-[13px] font-medium text-wb-muted transition-colors hover:bg-wb-rail hover:text-wb-text disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-wb-muted pointer-coarse:py-3"
      >
        <span>Memory</span>
        {memoryCount > 0 ? (
          <span className="rounded-full bg-wb-text px-2 text-[11px] font-semibold leading-5 text-wb-surface">
            {memoryCount}
            <span className="sr-only"> waiting for review</span>
          </span>
        ) : null}
      </button>
    </aside>
  )
}
