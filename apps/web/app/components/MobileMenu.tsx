"use client"

import { usePathname } from "next/navigation"
import { useEffect, useId, useRef, useState } from "react"
import { MobileDocsNav } from "./docs/MobileDocsNav"
import headerStyles from "./homepage/header.module.css"
import { CopyCommand } from "./ui/CopyCommand"
import { Eyebrow } from "./ui/Eyebrow"
import { Icon } from "./ui/Icon"
import { SiteLink } from "./ui/SiteLink"

interface MenuLink {
  readonly label: string
  readonly href: string
  readonly download?: boolean
}

const SITE_LINKS: readonly MenuLink[] = [
  { label: "Docs", href: "/docs/getting-started" },
  { label: "Blog", href: "/blog" },
  { label: "Download brand kit", href: "/brand/b4-run-brand-assets.zip", download: true },
  { label: "GitHub", href: "https://github.com/cacheplane/b4run" },
]

/**
 * Full-screen mobile menu. Visible only below the md breakpoint.
 *
 * Trigger: hamburger button in the header.
 * Overlay: paper full-viewport sheet listing site links and (on a docs page)
 *          the Documentation nav. Primary action is the install command —
 *          same as the desktop nav.
 * Close: × button, Esc, or tapping any link.
 */
export function MobileMenu() {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const menuId = useId()

  const isDocsPage = pathname.startsWith("/docs")

  // Native modal dialogs remove their closed content from sequential focus
  // and make the rest of the page inert while open.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (isOpen && !dialog.open) dialog.showModal()
    if (!isOpen && dialog.open) dialog.close()
  }, [isOpen])

  // Do not leave an active modal hidden by the md:hidden breakpoint.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 48rem)")
    const closeAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setIsOpen(false)
    }

    if (desktop.matches) setIsOpen(false)
    desktop.addEventListener("change", closeAtDesktop)
    return () => desktop.removeEventListener("change", closeAtDesktop)
  }, [])

  // Body scroll lock + focus management
  useEffect(() => {
    if (isOpen) {
      const previous = document.body.style.overflow
      document.body.style.overflow = "hidden"
      // Focus the close button on open
      const closeBtn = closeRef.current
      const t = window.setTimeout(() => closeBtn?.focus(), 0)
      return () => {
        window.clearTimeout(t)
        document.body.style.overflow = previous
        // Return focus to the trigger
        triggerRef.current?.focus()
      }
    }
  }, [isOpen])

  // Close on route change
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger; isOpen is managed internally
  useEffect(() => {
    setIsOpen(false)
  }, [pathname])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="Open menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        data-ui="icon-button"
        className="md:hidden"
      >
        <Icon name="menu" size="md" />
      </button>

      <dialog
        ref={dialogRef}
        id={menuId}
        aria-label="Site menu"
        onCancel={(event) => {
          event.preventDefault()
          setIsOpen(false)
        }}
        onClose={() => setIsOpen(false)}
        className="md:hidden fixed inset-0 z-50 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-page p-0"
      >
        <div className="h-full overflow-y-auto">
          {/* Header strip: same bar as the site header, so × replaces ☰ in place */}
          <div
            className={`${headerStyles.bar} flex items-center justify-between border-b border-rule`}
          >
            <Eyebrow>Menu</Eyebrow>
            <button
              ref={closeRef}
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close menu"
              data-ui="icon-button"
            >
              <Icon name="close" size="md" />
            </button>
          </div>

          {/* Site section */}
          <div className={`${headerStyles.menuSection} px-6 py-6`}>
            <Eyebrow className="mb-3">Site</Eyebrow>
            <ul className="flex flex-col gap-0.5">
              {SITE_LINKS.map((link) => (
                <li key={link.label}>
                  <SiteLink
                    href={link.href}
                    {...(link.download ? { download: true } : {})}
                    onClick={() => setIsOpen(false)}
                    className="block text-base px-3 py-2.5 text-ink-muted hover:text-ink hover:bg-surface transition-colors"
                  >
                    {link.label}
                  </SiteLink>
                </li>
              ))}
            </ul>
            <div className="mt-5 px-3">
              <CopyCommand command="npm create b4-app@latest my-agent" />
            </div>
          </div>

          {/* Documentation section — only on docs pages */}
          {isDocsPage && (
            <div className={`${headerStyles.menuSection} px-6 pb-10 border-t border-rule pt-6`}>
              <Eyebrow className="mb-3">Documentation</Eyebrow>
              <MobileDocsNav pathname={pathname} onNavigate={() => setIsOpen(false)} />
            </div>
          )}
        </div>
      </dialog>
    </>
  )
}
