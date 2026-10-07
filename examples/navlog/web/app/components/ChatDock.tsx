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

/** The two header buttons' shared box: compact on a desktop pointer, 44 px tall under a finger. */
const HEADER_BUTTON =
  "wb-focus inline-flex min-h-7 shrink-0 items-center rounded-wb-sm px-2 text-[12px] transition-colors disabled:opacity-60 pointer-coarse:min-h-11 pointer-coarse:px-3"

/**
 * The run's state, as a word a person reads plus a dot: Running (pulsing,
 * the activity cards' running blue), Awaiting approval (amber, the gate's
 * color), Ready (muted). `status` is the shell's string — "running",
 * "awaiting approval", or nothing — so the mapping is here, not in the shell.
 * The dot is decoration; the word carries the meaning.
 */
export function statusPresentation(status: string | undefined): {
  readonly label: string
  readonly tone: "running" | "attention" | "idle"
} {
  if (status === "running") return { label: "Running", tone: "running" }
  if (status === "awaiting approval") return { label: "Awaiting approval", tone: "attention" }
  if (status === undefined || status.length === 0) return { label: "Ready", tone: "idle" }
  return { label: `${status[0]?.toUpperCase()}${status.slice(1)}`, tone: "idle" }
}

const TONE_CLASS = {
  running:
    "border-transparent bg-[color-mix(in_srgb,var(--b4-activity-running)_12%,transparent)] text-[var(--b4-activity-running,currentColor)]",
  attention: "border-amber-500/30 bg-[var(--wb-chat-warn-bg)] text-[var(--wb-chat-warn)]",
  idle: "border-wb-border text-wb-muted",
} as const

function StatusBadge({ status }: { status: string | undefined }) {
  const { label, tone } = statusPresentation(status)
  return (
    // On a phone the header is one row, so the badge shrinks to its dot; the
    // word stays in the accessibility tree and in the tooltip.
    <span
      title={label}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 max-md:border-transparent max-md:bg-transparent max-md:px-1 ${TONE_CLASS[tone]}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full bg-current max-md:size-2 ${tone === "running" ? "motion-safe:animate-pulse" : ""} ${tone === "idle" ? "opacity-60" : ""}`}
      />
      <span className="max-md:sr-only">{label}</span>
    </span>
  )
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
      {/*
        One wrapping row, reordered by width. Desktop: the brand and the two
        buttons on top, the title and status on a full-width row below, so the
        title is never squeezed beside a badge. Phone (below `md`, the layout's
        breakpoint): the dock is short, so the brand drops out and the title
        shares the one row with the buttons — every pixel there is transcript.
      */}
      <header className="relative flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1.5 border-b border-wb-border px-3 py-2 md:pb-2.5">
        <span className="wb-brand-mark mr-auto shrink-0 text-[13px] font-semibold tracking-tight max-md:hidden">
          B4.run navlog
        </span>
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
          className={`${HEADER_BUTTON} border border-wb-border bg-wb-surface font-medium text-wb-text hover:border-wb-muted`}
        >
          + New
        </button>
        <button
          type="button"
          aria-expanded={threadsOpen}
          aria-controls={threadsId}
          disabled={!hydrated}
          onClick={() => setThreadsOpen((open) => !open)}
          className={`${HEADER_BUTTON} text-wb-muted hover:bg-wb-rail hover:text-wb-text aria-expanded:bg-wb-rail aria-expanded:text-wb-text`}
        >
          Threads
        </button>
        <div className="order-last flex min-w-0 basis-full items-center gap-2 max-md:order-first max-md:flex-1 max-md:basis-0">
          {/*
            An h2: the page's one h1 is the empty state's "B4.run navlog". The
            title gets the whole row; `title` carries the full text when it
            truncates.
          */}
          <h2
            title={header}
            className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-5 tracking-tight"
          >
            {header}
          </h2>
          <StatusBadge status={status} />
        </div>

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
      <div className="max-h-[40%] shrink-0 overflow-auto border-b border-wb-border empty:hidden max-md:max-h-[30%]">
        {memory}
      </div>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      {composer}
    </section>
  )
}
