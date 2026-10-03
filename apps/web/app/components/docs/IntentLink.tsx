"use client"

import Link from "next/link"
import { type ComponentProps, useState } from "react"

/**
 * A `Link` that prefetches on intent (hover, focus, touch) instead of when it
 * scrolls into view. Long link lists — the docs sidebar has ~60 — otherwise
 * prefetch every visible route on each page load.
 */
export function IntentLink({
  onMouseEnter,
  onFocus,
  onTouchStart,
  ...props
}: Omit<ComponentProps<typeof Link>, "prefetch">) {
  const [intent, setIntent] = useState(false)
  return (
    <Link
      {...props}
      prefetch={intent ? null : false}
      onMouseEnter={(event) => {
        setIntent(true)
        onMouseEnter?.(event)
      }}
      onFocus={(event) => {
        setIntent(true)
        onFocus?.(event)
      }}
      onTouchStart={(event) => {
        setIntent(true)
        onTouchStart?.(event)
      }}
    />
  )
}
