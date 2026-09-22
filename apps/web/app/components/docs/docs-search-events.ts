/**
 * The docs search dialog is owned by `DocsSearch` (mounted in the docs layout);
 * other triggers, such as the header's mobile search button, open it with this
 * window event rather than carrying the search index themselves.
 */
export const OPEN_DOCS_SEARCH_EVENT = "b4:open-docs-search"

export function openDocsSearch(): void {
  window.dispatchEvent(new Event(OPEN_DOCS_SEARCH_EVENT))
}
