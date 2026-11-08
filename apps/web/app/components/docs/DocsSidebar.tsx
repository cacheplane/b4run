"use client"

import { usePathname } from "next/navigation"
import { DocsNavGroups } from "./DocsNavGroups"
import { DocsSearchTrigger } from "./DocsSearch"
import { DocsSectionSwitcher } from "./DocsSectionSwitcher"

export function DocsSidebar() {
  const pathname = usePathname()

  return (
    <div data-docs-sidebar>
      <DocsSectionSwitcher pathname={pathname} />
      <DocsSearchTrigger />
      <DocsNavGroups pathname={pathname} variant="sidebar" />
    </div>
  )
}
