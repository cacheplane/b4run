import { ALL_DOCS_PAGES } from "./nav"

/** Resolve only registered authored documentation; never accept arbitrary paths. */
export function docContentPath(href: string): string {
  const path = href.replace(/\/+$/, "")
  if (!ALL_DOCS_PAGES.some((page) => page.href === path))
    throw new Error(`Unknown documentation page: ${href}`)
  const slug = path.slice("/docs/".length)
  return `docs/${slug}${slug === "app" || slug === "recipes" ? "/index" : ""}.mdx`
}
