"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

/** Docs pages have their own sidebar and prev/next links, so they skip the site footer. */
export function HideOnDocs({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return pathname.startsWith("/docs") ? null : children
}
