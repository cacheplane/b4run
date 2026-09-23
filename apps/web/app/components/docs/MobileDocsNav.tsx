"use client"

import Link from "next/link"
import { DOCS_NAV } from "./nav"

interface Props {
  readonly pathname: string
  readonly onNavigate: () => void
}

export function MobileDocsNav({ pathname, onNavigate }: Props) {
  return (
    <nav aria-label="Documentation" className="space-y-2">
      {DOCS_NAV.map((section) => {
        const activeSection = section.items.some((item) => item.href === pathname)
        return (
          <details key={section.label} open={activeSection} className="group">
            {/* A <p> is invalid inside <summary>, so the eyebrow is a span
                carrying the attributes the Eyebrow component would. */}
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-ink-muted hover:bg-surface hover:text-ink">
              <span data-ui="eyebrow" data-tone="muted">
                {section.label}
              </span>
              <span aria-hidden className="text-xs transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>
            <ul className="mt-0.5 space-y-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      data-ui="nav-item"
                      {...(active ? { "aria-current": "page" as const } : {})}
                      className="text-sm px-3 py-2"
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </details>
        )
      })}
    </nav>
  )
}
