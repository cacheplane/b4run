const CANONICAL_BASE = "https://b4.run"

export function pageUrl(slug: string): string {
  return `${CANONICAL_BASE}/docs/${slug}`
}

export function sourceSlug(slug: string): string {
  return slug === "recipes" ? "recipes/index" : slug
}
