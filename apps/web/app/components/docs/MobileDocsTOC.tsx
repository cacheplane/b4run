"use client"

import { useRef } from "react"
import { useDocsHeadings } from "./use-docs-headings"

/**
 * "On this page" for viewports below lg, where the right-rail TOC is hidden.
 * A native disclosure near the top of the article; picking a heading closes it.
 */
export function MobileDocsTOC() {
  const { headings } = useDocsHeadings()
  const detailsRef = useRef<HTMLDetailsElement>(null)

  if (headings.length === 0) return null

  return (
    <details
      ref={detailsRef}
      data-mobile-docs-toc
      className="group lg:hidden mb-6 rounded-md border border-divider text-sm"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-divider-strong [&::-webkit-details-marker]:hidden">
        <span className="text-xs uppercase tracking-widest">On this page</span>
        <span aria-hidden className="text-xs transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <nav aria-label="On this page" className="border-t border-divider px-1 py-1">
        <ul>
          {headings.map((h) => (
            <li key={h.id}>
              <a
                href={`#${h.id}`}
                onClick={() => {
                  if (detailsRef.current) detailsRef.current.open = false
                }}
                className="flex min-h-11 items-center rounded-md pr-3 text-ink-muted hover:bg-surface hover:text-ink [overflow-wrap:anywhere]"
                style={{ paddingLeft: h.level === 3 ? 28 : 12 }}
              >
                {h.text}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  )
}
