"use client"

import { Eyebrow } from "../ui/Eyebrow"
import { useDocsHeadings } from "./use-docs-headings"

export function DocsTOC() {
  const { headings, activeId } = useDocsHeadings()

  if (headings.length === 0) return null

  return (
    <nav aria-label="On this page" className="w-full hidden lg:block text-sm">
      <Eyebrow className="mb-3">On this page</Eyebrow>
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
