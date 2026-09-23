import { type DocsSearchResult, flattenDocsSearchIndex } from "./docs-search-results"
import type { DocsSearchEntry } from "./search-index"

/**
 * The search dialog is owned by `DocsSearch`, mounted once in the site header;
 * triggers (the docs sidebar button, the header search buttons) open it with
 * this window event rather than carrying the search index themselves.
 */
export const OPEN_DOCS_SEARCH_EVENT = "b4:open-docs-search"

/** The static route the index is served from; see `app/search-index.json`. */
export const DOCS_SEARCH_INDEX_URL = "/search-index.json"

export function openDocsSearch(): void {
  window.dispatchEvent(new Event(OPEN_DOCS_SEARCH_EVENT))
}

let pending: Promise<readonly DocsSearchResult[]> | null = null

/**
 * Fetch the search index once per page load. Triggers call this on hover and
 * focus so the index is usually ready by the time the dialog opens; a failed
 * fetch is forgotten so the next attempt retries.
 */
export function loadDocsSearchIndex(): Promise<readonly DocsSearchResult[]> {
  pending ??= fetch(DOCS_SEARCH_INDEX_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`Search index request failed: ${response.status}`)
      return response.json() as Promise<readonly DocsSearchEntry[]>
    })
    .then(flattenDocsSearchIndex)
    .catch((error: unknown) => {
      pending = null
      throw error
    })
  return pending
}

/** Test seam: forget a loaded index. */
export function resetDocsSearchIndex(): void {
  pending = null
}

/** Whether a keydown's target is somewhere the user is typing text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag !== "INPUT") return false
  const type = (target as HTMLInputElement).type
  return !["button", "checkbox", "radio", "range", "reset", "submit", "color", "file"].includes(
    type,
  )
}
