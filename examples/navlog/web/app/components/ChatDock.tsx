"use client"
import { type ReactNode, useEffect, useId, useState } from "react"
import { useHydrated } from "../lib/use-hydrated"

export interface ChatDockProps {
  readonly header: string
  readonly status?: string | undefined
  readonly rail: ReactNode
  readonly memory: ReactNode
  readonly children: ReactNode
  readonly composer: ReactNode
  /** Starts a new conversation; the header button that calls it is always in view. */
  readonly onNewConversation: () => void
}

/**
 * The floating chat panel. The thread list lives behind a "Threads"
 * disclosure in the header instead of a permanent column; "+ New
 * conversation" stays in the header itself, always reachable. The memory
 * panel sits inline above the transcript rather than behind a second
 * disclosure: it renders nothing until a candidate is waiting, so it costs no
 * space until there is something to approve, and then it is in view (the
 * teach journey and a person both need to see it without hunting for it).
 *
 * "Threads" is a disclosure BUTTON (`aria-expanded`, `aria-controls`) rather
 * than `<details>`: it has a stable button role and name, which is how the
 * browser journeys open it, and the panel closes on Escape.
 */
export function ChatDock({
  header,
  status,
  rail,
  memory,
  children,
  composer,
  onNewConversation,
}: ChatDockProps) {
  const [threadsOpen, setThreadsOpen] = useState(false)
  const threadsId = useId()
  const hydrated = useHydrated()

  useEffect(() => {
    if (!threadsOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setThreadsOpen(false)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [threadsOpen])

  return (
    // `min-w-0`: as a flex item the dock would otherwise grow to its widest
    // content (a long tool-call argument line) and spill over the map.
    <section
      className="wb-panel wb-dock relative flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Chat"
    >
      <header className="relative flex shrink-0 items-center gap-2 border-b border-wb-border px-3 py-2">
        <span className="wb-brand-mark shrink-0 text-[14px] font-semibold tracking-tight">
          B4.run navlog
        </span>
        {/* An h2: the page's one h1 is the empty state's "B4.run navlog". */}
        <h2 className="min-w-0 truncate text-[12.5px] font-medium">{header}</h2>
        {status ? (
          <span className="shrink-0 text-[11px] uppercase tracking-[0.08em] text-wb-muted">
            {status}
          </span>
        ) : null}
        {/*
          The visible text is short for the dock's width; the accessible name
          is the rail's full "+ New conversation", which contains it.
        */}
        {/*
          Both header buttons are disabled until hydration. They are in the
          server render, so they are visible before their handlers exist, and
          a click in that window is dropped: under load, the browser journey's
          Threads click landed there and the list never opened.
        */}
        <button
          type="button"
          aria-label="+ New conversation"
          disabled={!hydrated}
          onClick={onNewConversation}
          className="wb-focus ml-auto shrink-0 rounded-wb-sm border border-wb-border px-2 py-0.5 text-[12px] font-medium hover:border-wb-muted disabled:opacity-60"
        >
          + New
        </button>
        <button
          type="button"
          aria-expanded={threadsOpen}
          aria-controls={threadsId}
          disabled={!hydrated}
          onClick={() => setThreadsOpen((open) => !open)}
          className="wb-focus shrink-0 rounded-wb-sm px-1.5 py-0.5 text-[12px] text-wb-muted hover:text-wb-text disabled:opacity-60"
        >
          Threads
        </button>
        {threadsOpen ? (
          // A plain block, not a flex column: the rail's `flex-1 min-h-0`
          // children are meant for a full-height column and could otherwise
          // shrink to nothing inside this content-sized popover.
          <div
            id={threadsId}
            className="wb-panel absolute right-2 top-full z-20 mt-1 block max-h-[60vh] w-72 overflow-auto py-2"
          >
            {rail}
          </div>
        ) : null}
      </header>
      <div className="max-h-[40%] shrink-0 overflow-auto border-b border-wb-border empty:hidden">
        {memory}
      </div>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      {composer}
    </section>
  )
}
