"use client"

import { usePathname } from "next/navigation"
import { DocsNavGroups } from "./DocsNavGroups"
import { DocsSearchTrigger } from "./DocsSearch"

export function DocsSidebar() {
  const pathname = usePathname()

  return (
    <div data-docs-sidebar>
      <p className="text-xs text-ink-dim uppercase tracking-widest mb-4 flex items-center gap-2">
        <span className="inline-block w-1 h-1 rounded-full bg-accent-saas" aria-hidden />
        Documentation
      </p>
      <DocsSearchTrigger />
      <DocsNavGroups pathname={pathname} variant="sidebar" />
    </div>
  )
}
