"use client"

import { CopyStatus, useCopyFeedback } from "../copy-feedback"

/**
 * The `#` self-link after an H2/H3: shown on hover or focus, it moves to the
 * section (updating the URL hash) and copies the section's URL. It lives in a
 * `[data-heading-anchor]` wrapper so outline readers can skip its text.
 */
export function HeadingAnchor({ id, label }: { readonly id: string; readonly label: string }) {
  const { state, copy } = useCopyFeedback()
  return (
    <span data-heading-anchor className="ml-2 inline-flex items-center gap-2 align-middle">
      <a
        href={`#${id}`}
        onClick={() => {
          void copy(`${window.location.origin}${window.location.pathname}#${id}`)
        }}
        // prose.css underlines links from @layer components, so the utility wins.
        className="inline-flex h-7 w-7 items-center justify-center text-base font-normal text-ink-muted no-underline opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/heading:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <span aria-hidden>#</span>
        <span className="sr-only">Copy link to section: {label}</span>
      </a>
      <CopyStatus
        state={state}
        messages={{ idle: "", copied: "Link copied", error: "Copy failed" }}
        className="text-xs font-normal text-ink-muted"
      />
    </span>
  )
}
