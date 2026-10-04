import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { Chevron } from "./icons.js"

/**
 * Open/closed per spec §3.1: automation decides until the user toggles, and
 * the user's choice holds until the item becomes live again.
 */
export function useDisclosure(
  autoOpen: boolean,
  live: boolean,
): { open: boolean; toggle: () => void } {
  const [manual, setManual] = useState<boolean | undefined>(undefined)
  const wasLive = useRef(live)
  useEffect(() => {
    if (live && !wasLive.current) setManual(undefined)
    wasLive.current = live
  }, [live])
  const open = manual ?? autoOpen
  const toggle = useCallback(() => setManual(!open), [open])
  return { open, toggle }
}

export interface DisclosureProps {
  readonly autoOpen: boolean
  readonly live: boolean
  /** Class of the toggle button (`b4-turn__summary`, `b4-step__line`). */
  readonly className: string
  readonly summary: ReactNode
  /** Rendered only while open. */
  readonly children: ReactNode
  /** Extra attributes for the button (data-state and the like). */
  readonly buttonProps?: Readonly<Record<string, string | undefined>>
  /** Wrapper around the panel (`b4-step__detail`, `b4-step__children`); defaults to a fragment. */
  readonly panelClassName?: string
  /** When set, the parent reads the open state (for `data-expanded`). */
  readonly onOpenChange?: (open: boolean) => void
}

/** A `<button aria-expanded>` plus its panel; 24px+ tall through CSS (spec §5.5). */
export function Disclosure(props: DisclosureProps): ReactElement {
  const { open, toggle } = useDisclosure(props.autoOpen, props.live)
  const { onOpenChange } = props
  useEffect(() => onOpenChange?.(open), [open, onOpenChange])
  return (
    <>
      <button
        type="button"
        className={props.className}
        aria-expanded={open}
        onClick={toggle}
        {...props.buttonProps}
      >
        <Chevron />
        {props.summary}
      </button>
      {open ? (
        props.panelClassName ? (
          <div className={props.panelClassName}>{props.children}</div>
        ) : (
          props.children
        )
      ) : null}
    </>
  )
}
