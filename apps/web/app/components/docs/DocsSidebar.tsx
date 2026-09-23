"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Eyebrow } from "../ui/Eyebrow"
import { DocsSearch } from "./DocsSearch"
import { DOCS_NAV } from "./nav"
import type { DocsSearchEntry } from "./search-index"

interface Props {
  readonly searchIndex: readonly DocsSearchEntry[]
}

export function DocsSidebar({ searchIndex }: Props) {
  const pathname = usePathname()

  return (
    <div data-docs-sidebar>
      <Eyebrow className="mb-4 flex items-center gap-2">
        <span className="inline-block w-1 h-1 bg-relay" aria-hidden />
        Documentation
      </Eyebrow>
      <DocsSearch index={searchIndex} />
      <nav aria-label="Documentation" className="space-y-6 mt-4">
        {DOCS_NAV.map((section) => (
          <div key={section.label}>
            <Eyebrow className="mb-1.5 px-3">{section.label}</Eyebrow>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      data-docs-nav-item
                      data-ui="nav-item"
                      aria-current={active ? "page" : undefined}
                      className="text-sm pl-[9px] pr-3 py-1.5"
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  )
}
