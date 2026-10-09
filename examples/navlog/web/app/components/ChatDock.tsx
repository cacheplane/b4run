"use client"
import type { ReactNode } from "react"

export interface ChatDockProps {
  readonly header: string
  readonly status?: string | undefined
  readonly memory: ReactNode
  /** A failure to show above the conversation (`RunError`), or nothing. */
  readonly banner?: ReactNode
  /** Content-parts-dropped notices for the open thread (`DropNotices`), or nothing. */
  readonly notices?: ReactNode
  /** The conversation: `NavlogChat`, which holds the messages and the input. */
  readonly children: ReactNode
}

/**
 * The run's state, as a word a person reads plus a dot: Running (pulsing,
 * the activity kit's running color), Awaiting approval (amber, the gate's
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
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 max-lg:border-transparent max-lg:bg-transparent max-lg:px-1 ${TONE_CLASS[tone]}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full bg-current max-lg:size-2 ${tone === "running" ? "motion-safe:animate-pulse" : ""} ${tone === "idle" ? "opacity-60" : ""}`}
      />
      <span className="max-lg:sr-only">{label}</span>
    </span>
  )
}

/**
 * The chat column: the thread's title and run status, the memory panel, the
 * failure banner, drop notices and the conversation.
 *
 * The brand, "New plan" and the thread list are the sidenav's (`SideNav`).
 * The memory panel stays here, inline above the conversation, rather than
 * behind a link: it renders nothing until a candidate is waiting, so it costs
 * no space until there is something to approve, and then it is in view (the
 * teach journey and a person both need to see it without hunting for it).
 * The sidenav's "Memory" item counts the candidates and scrolls here.
 */
export function ChatDock({ header, status, memory, banner, notices, children }: ChatDockProps) {
  return (
    // `min-w-0`: as a flex item the dock would otherwise grow to its widest
    // content (a long tool-call argument line) and spill into the map.
    <section
      className="wb-panel wb-dock relative flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Chat"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-wb-border px-3 py-2.5">
        {/* `title` carries the full text when it truncates. */}
        <h2
          title={header}
          className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-5 tracking-tight"
        >
          {header}
        </h2>
        <StatusBadge status={status} />
      </header>
      <div className="max-h-[30%] shrink-0 overflow-auto border-b border-wb-border empty:hidden max-lg:max-h-[25%]">
        {memory}
      </div>
      {banner ? <div className="shrink-0 px-3 pt-2">{banner}</div> : null}
      {notices}
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </section>
  )
}
