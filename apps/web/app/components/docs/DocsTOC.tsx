"use client"

import { useDocsHeadings } from "./use-docs-headings"

export function DocsTOC() {
  const { headings, activeId } = useDocsHeadings()

  if (headings.length === 0) return null

  return (
    <nav aria-label="On this page" className="w-full hidden lg:block text-sm">
      <p className="text-xs text-ink-dim uppercase tracking-widest mb-3">On this page</p>
      <ul className="space-y-2 border-l border-divider">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              aria-current={activeId === h.id ? "location" : undefined}
              className={`block py-0.5 transition-colors -ml-px border-l [overflow-wrap:anywhere] ${
                activeId === h.id
                  ? "text-accent-saas border-accent-saas"
                  : "text-ink-dim border-transparent hover:text-ink"
              }`}
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
