"use client"

import posthog from "posthog-js"
import { SIGNAL_EVENTS, type SignalEventName, type SignalProperties } from "./events"

const MAX_LABEL_LENGTH = 128

/** Every property a signal may carry; anything else is dropped at runtime. */
export const SIGNAL_PROPERTY_KEYS = [
  "cta_id",
  "surface",
  "destination_url",
  "destination_host",
  "engaged_seconds",
  "code_lang",
  "source_page",
] as const satisfies readonly (keyof SignalProperties)[]

// Adding a property to SignalProperties without listing it above is a type error.
const _allKeysListed: [
  Exclude<keyof SignalProperties, (typeof SIGNAL_PROPERTY_KEYS)[number]>,
] extends [never]
  ? true
  : never = true
void _allKeysListed

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
    for (const key of SIGNAL_PROPERTY_KEYS) {
      const value: unknown = properties[key]
      if (key === "engaged_seconds") {
        if (value === 10 || value === 30) payload[key] = value
      } else if (key === "source_page") {
        const label = safeLabel(value)
        if (label !== undefined) payload[key] = sourcePage(label)
      } else {
        const label = safeLabel(value)
        if (label !== undefined) payload[key] = label
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
