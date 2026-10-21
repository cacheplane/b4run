"use client"

import { usePathname } from "next/navigation"
import { useEffect } from "react"
import { classifyClick } from "./click-signals"
import { track } from "./client"
import { createEngagedTimeTracker } from "./engaged-time"
import { SIGNAL_EVENTS } from "./events"

/**
 * Site-wide signals that need no per-component wiring: delegated link and
 * call-to-action clicks, and visible time per page view. Mounted
 * once in the root layout; renders nothing.
 */
export function SiteSignals() {
  const pathname = usePathname()

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

    document.addEventListener("click", onClick, true)
    return () => document.removeEventListener("click", onClick, true)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname restarts the clock
  useEffect(() => {
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

    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.clearInterval(interval)
    }
  }, [pathname])

  return null
}
