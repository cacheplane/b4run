import { type ReactElement, type ReactNode, useCallback, useEffect, useState } from "react"
import {
  initialDisclosure,
  isDisclosureOpen,
  observeDisclosure,
  toggleDisclosure,
} from "../../view/activity-disclosure.js"
import { Chevron } from "./icons.js"

/**
 * Open/closed per spec §3.1, the shared rule in `@b4run/ag-ui/view`
 * (`observeDisclosure`): automation decides until the user toggles, and the
 * user's choice holds until the item becomes live again — where "again" means
 * a *different* presentation of it. Pass `resetKey` (a step's `startedAt`) so
 * a call that goes awaiting → running under the same key never closes what
 * the user opened. Without a key, every rise of `live` clears the choice.
 */
export function useDisclosure(
  autoOpen: boolean,
  live: boolean,
  resetKey?: unknown,
): { open: boolean; toggle: () => void } {
  const [memory, setMemory] = useState(() => initialDisclosure(live, resetKey))
  useEffect(() => {
    setMemory((current) => observeDisclosure(current, live, resetKey))
  }, [live, resetKey])
  const open = isDisclosureOpen(memory, autoOpen)
  const toggle = useCallback(
    () => setMemory((current) => toggleDisclosure(current, autoOpen)),
    [autoOpen],
  )
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
