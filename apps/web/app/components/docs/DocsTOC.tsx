"use client"

import { useDocsHeadings } from "./use-docs-headings"

export function DocsTOC() {
  const { headings, activeId } = useDocsHeadings()

  if (headings.length === 0) return null

  return (
    <nav aria-label="On this page" className="w-full hidden lg:block text-sm">
      <p className="mb-3 font-semibold text-ink-muted">On this page</p>
      <ul className="space-y-2 border-l border-rule">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              data-ui="nav-item"
              aria-current={activeId === h.id ? "location" : undefined}
              className="py-0.5 -ml-px [overflow-wrap:anywhere]"
              style={{ paddingLeft: h.level === 3 ? 24 : 12 }}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
