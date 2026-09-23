"use client"

import { usePathname } from "next/navigation"
import { Eyebrow } from "../ui/Eyebrow"
import { DocsNavGroups } from "./DocsNavGroups"
import { DocsSearchTrigger } from "./DocsSearch"

export function DocsSidebar() {
  const pathname = usePathname()

  return (
    <div data-docs-sidebar>
      <Eyebrow className="mb-4 flex items-center gap-2">
        <span className="inline-block w-1 h-1" aria-hidden />
        Documentation
      </Eyebrow>
      <DocsSearchTrigger />
      <DocsNavGroups pathname={pathname} variant="sidebar" />
    </div>
  )
}
