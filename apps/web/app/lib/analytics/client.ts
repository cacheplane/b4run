"use client"

import posthog from "posthog-js"
import { SIGNAL_EVENTS, type SignalEventName, type SignalProperties } from "./events"

const MAX_LABEL_LENGTH = 128

/** The pathname of a full URL or path: no search, no hash, "/" if unparseable. */
export function sourcePage(href: string): string {
  try {
    return new URL(href, "http://localhost").pathname || "/"
  } catch {
    return "/"
  }
}

/** A trimmed string capped at 128 characters, or undefined when blank or not a string. */
export function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  return trimmed.slice(0, MAX_LABEL_LENGTH)
}

/** Sends a product signal. Never throws and does nothing on the server. */
export function track(event: SignalEventName, properties: SignalProperties = {}): void {
  if (typeof window === "undefined") return
  try {
    const payload: Record<string, string | number> = {}
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value === "string") {
        const label = safeLabel(value)
        if (label !== undefined) payload[key] = label
      } else if (typeof value === "number") {
        payload[key] = value
      }
    }
    if (payload.source_page === undefined) {
      payload.source_page = sourcePage(window.location.pathname)
    }
    posthog.capture(event, payload)
  } catch {
    // A failed signal must never surface to a reader.
  }
}

/** The copy-code event for a page path, or undefined outside docs and blog. */
export function copyCodeEventFor(pathname: string): SignalEventName | undefined {
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return SIGNAL_EVENTS.docsCopyCodeClick
  if (pathname === "/blog" || pathname.startsWith("/blog/")) return SIGNAL_EVENTS.blogCopyCodeClick
  return undefined
}
