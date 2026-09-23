"use client"

import { useEffect, useRef } from "react"
import { IntentLink } from "./IntentLink"
import { DOCS_NAV } from "./nav"

interface Props {
  readonly pathname: string
  /** `sidebar`: the desktop rail; `menu`: the mobile menu sheet (44px rows). */
  readonly variant: "sidebar" | "menu"
  readonly onNavigate?: () => void
}

const SUMMARY_CLASS =
  "flex cursor-pointer list-none items-center justify-between rounded-md px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-divider-strong [&::-webkit-details-marker]:hidden"

/** Scroll `item` into the middle third of its scrolling ancestor, if it is out of view. */
function revealInScroller(item: HTMLElement) {
  const scroller = item.closest<HTMLElement>("[data-docs-nav-scroller]")
  if (!scroller) return
  const view = scroller.getBoundingClientRect()
  const box = item.getBoundingClientRect()
  if (box.top >= view.top && box.bottom <= view.bottom) return
  scroller.scrollTop += box.top - view.top - view.height / 3
}

/**
 * The documentation nav as native disclosures, one per section, with only the
 * current page's section open. Native `<details>` works without JavaScript.
 */
export function DocsNavGroups({ pathname, variant, onNavigate }: Props) {
  const navRef = useRef<HTMLElement>(null)

  // On load and after each navigation, make sure the current page's group is
  // open (the reader may have collapsed it) and its link is in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger; the DOM is read inside
  useEffect(() => {
    const current = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!current) return
    const group = current.closest("details")
    if (group && !group.open) group.open = true
    if (variant === "sidebar") revealInScroller(current)
  }, [pathname, variant])

  const menu = variant === "menu"
  return (
    <nav ref={navRef} aria-label="Documentation" className={menu ? "space-y-2" : "space-y-1 mt-2"}>
      {DOCS_NAV.map((section) => {
        const activeSection = section.items.some((item) => item.href === pathname)
        return (
          <details key={section.label} open={activeSection} className="group">
            <summary className={`${SUMMARY_CLASS} ${menu ? "min-h-11 py-2" : "py-1.5"}`}>
              {section.label}
              <span aria-hidden className="text-xs transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>
            <ul className={menu ? "mt-0.5 space-y-0.5" : "mt-0.5 mb-3 space-y-0.5"}>
              {section.items.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <IntentLink
                      href={item.href}
                      {...(onNavigate ? { onClick: onNavigate } : {})}
                      {...(active ? { "aria-current": "page" as const } : {})}
                      {...(menu ? {} : { "data-docs-nav-item": "" })}
                      className={`block rounded-md transition-colors ${
                        menu ? "px-3 py-2 text-sm" : "text-sm pl-[9px] pr-3 py-1.5"
                      } ${
                        active
                          ? menu
                            ? "text-accent-saas bg-accent-saas-soft"
                            : "text-accent-saas bg-accent-saas/15"
                          : "text-ink-muted hover:text-ink hover:bg-surface"
                      }`}
                    >
                      {item.label}
                    </IntentLink>
                  </li>
                )
              })}
            </ul>
          </details>
        )
      })}
    </nav>
  )
}
