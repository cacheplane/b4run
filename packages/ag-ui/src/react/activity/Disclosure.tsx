import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { Chevron } from "./icons.js"

/**
 * Open/closed per spec §3.1: automation decides until the user toggles, and
 * the user's choice holds until the item becomes live again — where "again"
 * means a *different* presentation of it. Pass `resetKey` (a step's
 * `startedAt`) so a call that goes awaiting → running under the same key
 * never closes what the user opened; the choice is cleared only when the
 * item is live under a key it has not been live under before. Without a key,
 * every rise of `live` clears the choice.
 */
export function useDisclosure(
  autoOpen: boolean,
  live: boolean,
  resetKey?: unknown,
): { open: boolean; toggle: () => void } {
  const [manual, setManual] = useState<boolean | undefined>(undefined)
  const wasLive = useRef(live)
  const lastKey = useRef(resetKey)
  useEffect(() => {
    const rose = live && !wasLive.current
    wasLive.current = live
    if (!live) return
    const changed = resetKey === undefined ? rose : resetKey !== lastKey.current
    if (!changed) return
    lastKey.current = resetKey
    setManual(undefined)
  }, [live, resetKey])
  const open = manual ?? autoOpen
  const toggle = useCallback(() => setManual(!open), [open])
  return { open, toggle }
}

export interface DisclosureProps {
  readonly open: boolean
  readonly onToggle: () => void
  /** Class of the toggle button (`b4-turn__summary`, `b4-step__line`). */
  readonly className: string
  readonly summary: ReactNode
  /** Rendered only while open. */
  readonly children: ReactNode
  /** Wrapper around the panel (`b4-step__detail`, `b4-step__children`); defaults to a fragment. */
  readonly panelClassName?: string
}

/**
 * A controlled `<button aria-expanded>` plus its panel; 24px+ tall through
 * CSS (spec §5.5). The parent owns `open` (see {@link useDisclosure}) so its
 * `data-expanded` and this button never disagree, even for one commit.
 */
export function Disclosure(props: DisclosureProps): ReactElement {
  return (
    <>
      <button
        type="button"
        className={props.className}
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <Chevron />
        {props.summary}
      </button>
      {props.open ? (
        props.panelClassName ? (
          <div className={props.panelClassName}>{props.children}</div>
        ) : (
          props.children
        )
      ) : null}
    </>
  )
}
