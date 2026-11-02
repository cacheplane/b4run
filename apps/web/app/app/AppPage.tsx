import type { ReactNode } from "react"

/** The site's reading column for the Agent Workspace pages. */
export function AppPage({ children }: { readonly children: ReactNode }) {
  return (
    <main
      id="content"
      tabIndex={-1}
      className="min-w-0 px-6 md:px-12 py-12 max-w-[760px] mx-auto w-full"
    >
      <article className="prose-b4">{children}</article>
    </main>
  )
}

/** Marks a page whose copy the owner has not written or reviewed yet. */
export function DraftBanner() {
  return (
    <p
      role="note"
      data-draft-banner
      className="border border-rule-strong bg-relay-tint text-relay-ink px-4 py-3 text-sm font-medium"
    >
      Draft: not yet reviewed
    </p>
  )
}
