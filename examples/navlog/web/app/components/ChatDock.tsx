"use client"
import type { ReactNode } from "react"

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
 * The floating chat panel. The thread rail lives behind a "Threads" disclosure
 * in the header instead of a permanent column. The memory panel sits inline
 * above the transcript rather than behind a second disclosure: it renders
 * nothing until a candidate is waiting, so it costs no space until there is
 * something to approve, and then it is in view (the teach journey and a person
 * both need to see it without hunting for it).
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
  return (
    <section className="wb-panel wb-dock relative flex min-h-0 flex-1 flex-col" aria-label="Chat">
      <header className="flex shrink-0 items-center gap-2 border-b border-wb-border px-3 py-2">
        <span className="wb-brand-mark shrink-0 text-[14px] font-semibold tracking-tight">
          B4.run navlog
        </span>
        <h1 className="min-w-0 truncate text-[12.5px] font-medium">{header}</h1>
        {status ? (
          <span className="shrink-0 text-[11px] uppercase tracking-[0.08em] text-wb-muted">
            {status}
          </span>
        ) : null}
        {/*
          The visible text is short for the dock's width; the accessible name
          is the rail's full "+ New conversation", which contains it.
        */}
        <button
          type="button"
          aria-label="+ New conversation"
          onClick={onNewConversation}
          className="wb-focus ml-auto shrink-0 rounded-wb-sm border border-wb-border px-2 py-0.5 text-[12px] font-medium hover:border-wb-muted"
        >
          + New
        </button>
        <details className="shrink-0">
          <summary className="wb-focus cursor-pointer list-none text-[12px] text-wb-muted">
            Threads
          </summary>
          <div className="wb-panel absolute right-2 z-20 mt-1 flex max-h-[60vh] w-72 flex-col overflow-auto py-2">
            {rail}
          </div>
        </details>
      </header>
      <div className="max-h-[40%] shrink-0 overflow-auto border-b border-wb-border empty:hidden">
        {memory}
      </div>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      {composer}
    </section>
  )
}
