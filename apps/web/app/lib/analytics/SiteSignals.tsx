"use client"

import { useEffect } from "react"
import { OPEN_DOCS_SEARCH_EVENT } from "../../components/docs/docs-search-events"
import { classifyClick } from "./click-signals"
import { track } from "./client"
import { createEngagedTimeTracker } from "./engaged-time"
import { SIGNAL_EVENTS } from "./events"

/**
 * Site-wide signals that need no per-component wiring: delegated link and
 * call-to-action clicks, visible time, and the docs search opening. Mounted
 * once in the root layout; renders nothing.
 */
export function SiteSignals() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const signal = classifyClick(event.target, window.location.origin)
      if (signal === undefined) return
      if (signal.event === SIGNAL_EVENTS.siteCtaClick) {
        track(signal.event, {
          cta_id: signal.cta_id,
          surface: signal.surface,
          ...(signal.destination_url !== undefined
            ? { destination_url: signal.destination_url }
            : {}),
        })
      } else {
        track(signal.event, {
          destination_host: signal.destination_host,
          surface: signal.surface,
        })
      }
    }

    const visible = () => document.visibilityState === "visible"
    const engaged = createEngagedTimeTracker({
      now: Date.now,
      startVisible: visible(),
      onThreshold: (thresholdMs) =>
        track(SIGNAL_EVENTS.siteEngagedTime, {
          engaged_seconds: thresholdMs === 10_000 ? 10 : 30,
        }),
    })
    const onVisibility = () => engaged.setVisible(visible())
    const interval = window.setInterval(() => {
      engaged.tick()
      if (engaged.isComplete()) window.clearInterval(interval)
    }, 1_000)

    const onSearchOpen = () => track(SIGNAL_EVENTS.docsSearchOpen)

    document.addEventListener("click", onClick, true)
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener(OPEN_DOCS_SEARCH_EVENT, onSearchOpen)
    return () => {
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener(OPEN_DOCS_SEARCH_EVENT, onSearchOpen)
      window.clearInterval(interval)
    }
  }, [])

  return null
}
