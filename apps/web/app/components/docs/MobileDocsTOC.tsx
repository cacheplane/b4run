"use client"

import { useRef } from "react"
import { Eyebrow } from "../ui/Eyebrow"
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
      className="group lg:hidden mb-6 border border-rule text-sm"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <Eyebrow as="span">On this page</Eyebrow>
        <span aria-hidden className="text-xs transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <nav aria-label="On this page" className="border-t border-rule px-1 py-1">
        <ul>
          {headings.map((h) => (
            <li key={h.id}>
              <a
                href={`#${h.id}`}
                onClick={() => {
                  if (detailsRef.current) detailsRef.current.open = false
                }}
                data-ui="nav-item"
                className="flex min-h-11 items-center pr-3 [overflow-wrap:anywhere]"
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
