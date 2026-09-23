"use client"

import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"

export interface DocsHeading {
  readonly id: string
  readonly text: string
  readonly level: 2 | 3
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
}

/** A heading's own text, without its copy-link affordance. */
function headingText(el: HTMLHeadingElement): string {
  if (!el.querySelector("[data-heading-anchor]")) return el.textContent?.trim() ?? ""
  const clone = el.cloneNode(true) as HTMLHeadingElement
  for (const anchor of clone.querySelectorAll("[data-heading-anchor]")) anchor.remove()
  return clone.textContent?.trim() ?? ""
}

/** Reads the H2/H3 outline of the current docs article, assigning ids where missing. */
export function collectDocsHeadings(root: ParentNode = document): {
  readonly headings: readonly DocsHeading[]
  readonly elements: readonly HTMLHeadingElement[]
} {
  const article = root.querySelector("article.prose-b4")
  if (!article) return { headings: [], elements: [] }
  const elements = Array.from(article.querySelectorAll<HTMLHeadingElement>("h2, h3"))
  const headings = elements.map((el) => {
    const text = headingText(el)
    const id = el.id || slugify(text)
    if (!el.id) el.id = id
    return { id, text, level: el.tagName === "H2" ? 2 : 3 } as const
  })
  return { headings, elements }
}

/**
 * The current docs page's headings plus the one being read. Re-collected on
 * every pathname change: the desktop TOC lives in the persistent docs layout,
 * so a mount-only read would keep showing the first page's outline after a
 * client-side navigation.
 */
export function useDocsHeadings(): {
  readonly headings: readonly DocsHeading[]
  readonly activeId: string | null
} {
  const pathname = usePathname()
  const [headings, setHeadings] = useState<readonly DocsHeading[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger; the DOM is read inside
  useEffect(() => {
    setActiveId(null)
    const { headings: parsed, elements } = collectDocsHeadings()
    setHeadings(parsed)
    if (elements.length === 0 || typeof IntersectionObserver === "undefined") return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.target.getBoundingClientRect().top - b.target.getBoundingClientRect().top,
          )
        const first = visible[0]
        if (first) setActiveId(first.target.id)
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 1 },
    )
    for (const el of elements) observer.observe(el)
    return () => observer.disconnect()
  }, [pathname])

  return { headings, activeId }
}
