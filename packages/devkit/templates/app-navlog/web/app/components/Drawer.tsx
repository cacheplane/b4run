"use client"
import { type ReactNode, useEffect, useRef } from "react"

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface DrawerProps {
  readonly id: string
  /** Must be stable (`useCallback`): the focus effect re-runs when it changes. */
  readonly onClose: () => void
  readonly children: ReactNode
}

/**
 * The phone's navigation drawer: a modal dialog from the left over a scrim.
 * Focus moves into it on open and stays there (Tab and Shift+Tab wrap);
 * Escape and a tap on the scrim close it. Returning focus to the menu button
 * is the caller's `onClose`. Rendered only while open.
 */
export function Drawer({ id, onClose, children }: DrawerProps) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = panel.current
    element?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose()
        return
      }
      if (event.key !== "Tab" || element === null) return
      const items = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = items[0]
      const last = items.at(-1)
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 print:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        tabIndex={-1}
        className="wb-scrim absolute inset-0"
        onClick={onClose}
      />
      <div
        ref={panel}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="wb-drawer absolute inset-y-0 left-0 flex w-[80%] max-w-80 p-2 pt-[max(8px,env(safe-area-inset-top))] pb-[max(8px,env(safe-area-inset-bottom))]"
      >
        {children}
      </div>
    </div>
  )
}
