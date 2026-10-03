"use client"

import { useEffect } from "react"
import { type LegacyRedirect, resolveLegacyHash } from "./legacy-anchors"

/** Indirection so tests can observe the navigation without a real page load. */
export const legacyNavigation = {
  go(href: string): void {
    window.location.replace(href)
  },
}

interface Props {
  readonly redirects: readonly LegacyRedirect[]
}

/**
 * Keeps old `#fragment` links to moved sections working. Each old id stays in
 * the DOM as an empty element, so anchor checkers and readers without
 * JavaScript still land on the page. With JavaScript, a legacy hash sends the
 * reader to the section's new home.
 */
export function LegacyAnchorRedirect({ redirects }: Props) {
  useEffect(() => {
    if (redirects.length === 0) return
    const follow = () => {
      const target = resolveLegacyHash(window.location.hash, redirects)
      // Old links are rare, so a full navigation is fine and keeps this
      // component free of router context.
      if (target) legacyNavigation.go(target)
    }
    follow()
    window.addEventListener("hashchange", follow)
    return () => window.removeEventListener("hashchange", follow)
  }, [redirects])

  if (redirects.length === 0) return null
  return (
    <div aria-hidden="true" data-legacy-anchors="">
      {redirects.map(({ id }) => (
        <span key={id} id={id} />
      ))}
    </div>
  )
}
