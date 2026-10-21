export type ClickSignal =
  | { event: "site:cta_click"; cta_id: string; surface: string; destination_url?: string }
  | { event: "site:external_link_click"; destination_host: string; surface: string }

function surfaceFor(element: Element): string {
  const marked = element.closest("[data-signal-surface]")?.getAttribute("data-signal-surface")
  if (marked) return marked
  const path = element.ownerDocument.defaultView?.location.pathname ?? "/"
  if (path === "/docs" || path.startsWith("/docs/")) return "docs"
  if (path === "/blog" || path.startsWith("/blog/")) return "blog"
  return "home"
}

/**
 * Classifies a click target as a call-to-action click, an external link click,
 * or neither. A `[data-cta-id]` element wins and is counted once.
 */
export function classifyClick(
  target: EventTarget | null,
  currentOrigin: string,
): ClickSignal | undefined {
  if (
    target === null ||
    typeof (target as Element).closest !== "function" ||
    (target as Node).nodeType !== 1
  ) {
    return undefined
  }
  const element = (target as Element).closest("a[href], [data-cta-id]")
  if (element === null) return undefined

  const surface = surfaceFor(element)
  const base = element.ownerDocument.defaultView?.location.href ?? currentOrigin
  const href = element.getAttribute("href")
  let url: URL | undefined
  if (href !== null) {
    try {
      url = new URL(href, base)
    } catch {
      url = undefined
    }
  }

  const ctaId = element.getAttribute("data-cta-id")
  if (ctaId) {
    const destination =
      url !== undefined && (url.protocol === "http:" || url.protocol === "https:")
        ? url.origin === currentOrigin
          ? url.pathname
          : url.host
        : undefined
    return {
      event: "site:cta_click",
      cta_id: ctaId,
      surface,
      ...(destination !== undefined ? { destination_url: destination } : {}),
    }
  }

  if (
    url !== undefined &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin !== currentOrigin
  ) {
    return { event: "site:external_link_click", destination_host: url.host, surface }
  }
  return undefined
}
