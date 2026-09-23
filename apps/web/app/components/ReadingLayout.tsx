import type { ReactNode } from "react"

interface ReadingLayoutProps {
  readonly left: ReactNode
  /** Names the left complementary landmark (two unnamed asides are ambiguous). */
  readonly leftLabel: string
  readonly right: ReactNode
  readonly rightLabel: string
  readonly children: ReactNode
}

export function ReadingLayout({
  left,
  leftLabel,
  right,
  rightLabel,
  children,
}: ReadingLayoutProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)_240px] xl:grid-cols-[280px_minmax(0,1fr)_240px]">
      <aside
        aria-label={leftLabel}
        data-docs-nav-scroller
        className="hidden md:block sticky self-start overflow-y-auto px-6 pt-12 pb-8 border-r border-divider top-[var(--header-h)] h-[calc(100vh-var(--header-h))]"
      >
        {left}
      </aside>
      <main
        id="content"
        tabIndex={-1}
        className="min-w-0 px-6 md:px-12 py-12 max-w-[760px] mx-auto w-full"
      >
        {children}
      </main>
      <aside
        aria-label={rightLabel}
        className="hidden lg:block sticky self-start overflow-y-auto px-6 pt-12 pb-8 border-l border-divider top-[var(--header-h)] h-[calc(100vh-var(--header-h))]"
      >
        {right}
      </aside>
    </div>
  )
}
