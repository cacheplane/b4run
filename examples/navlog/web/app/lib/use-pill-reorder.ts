"use client"
import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react"
import { dropIndex } from "./drop-index"

/** A drag under way: the pill being moved, where it would land, how far it has travelled. */
export interface PillDrag {
  readonly from: number
  readonly to: number
  /** The pointer's horizontal travel since the press, in px: the pill follows it. */
  readonly dx: number
}

export interface PillReorderOptions {
  /** Called once, on drop, when the pill lands somewhere new. */
  readonly onMove: (from: number, to: number) => void
}

/** How far a mouse or pen moves with the button down before it is a drag, in px. */
const MOUSE_SLOP = 4
/** How long a finger rests on a pill before it is a drag, in ms. */
const HOLD_MS = 300
/** How far a finger may wander during the hold before it is a scroll instead, in px. */
const TOUCH_SLOP = 8

interface Session {
  readonly pointerId: number
  readonly pointerType: string
  readonly from: number
  readonly startX: number
  readonly startY: number
  readonly pill: HTMLElement
  timer: ReturnType<typeof setTimeout> | undefined
  /** The pills' horizontal middles, measured when the drag began. */
  centers: readonly number[] | null
  to: number
}

/**
 * Drag a pill along a row to a new place: the route bar's waypoint order.
 *
 * Pointer Events rather than HTML drag and drop, which phones barely support,
 * so mouse, pen and touch share one path. A mouse or pen drags once it moves a
 * few pixels with the button down, so a click is still a click. A finger has
 * to rest on the pill first ({@link HOLD_MS}): moving straight away scrolls
 * the row, as it always did. Escape, or the browser taking the gesture
 * (`pointercancel`), drops nothing.
 *
 * The hook only reports: `drag` while one is under way (the caller previews
 * it), and `onMove` once, on drop. Give the row `listRef`, and each pill the
 * handlers from `pillHandlers(index)`. A pill's own buttons (its ×) start no
 * drag: mark them `data-no-drag`.
 */
export function usePillReorder({ onMove }: PillReorderOptions) {
  const listRef = useRef<HTMLOListElement | null>(null)
  const session = useRef<Session | null>(null)
  const [drag, setDrag] = useState<PillDrag | null>(null)
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove

  const end = useCallback((commit: boolean): void => {
    const current = session.current
    session.current = null
    if (current === null) return
    clearTimeout(current.timer)
    if (current.pill.hasPointerCapture(current.pointerId)) {
      current.pill.releasePointerCapture(current.pointerId)
    }
    if (current.centers !== null) {
      setDrag(null)
      if (commit && current.to !== current.from) onMoveRef.current(current.from, current.to)
    }
  }, [])

  const begin = useCallback((current: Session): void => {
    const pills = listRef.current?.querySelectorAll<HTMLElement>(":scope > li") ?? []
    current.centers = [...pills].map((pill) => {
      const rect = pill.getBoundingClientRect()
      return rect.left + rect.width / 2
    })
    if (!current.pill.hasPointerCapture(current.pointerId)) {
      current.pill.setPointerCapture(current.pointerId)
    }
    setDrag({ from: current.from, to: current.from, dx: 0 })
  }, [])

  // A finger held still on a pill, then moved, would scroll the row: once the
  // drag has begun, its touchmove is cancelled. React's touch handlers are
  // passive, so this is a native listener, re-attached after every render
  // because the row only exists while the route has waypoints.
  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    const onTouchMove = (event: TouchEvent): void => {
      if (session.current?.centers != null && event.cancelable) event.preventDefault()
    }
    list.addEventListener("touchmove", onTouchMove, { passive: false })
    return () => list.removeEventListener("touchmove", onTouchMove)
  })

  // Escape drops the pill back where it was.
  useEffect(() => {
    if (drag === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") end(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [drag, end])

  // A drag cut short by an unmount leaves no timer behind.
  useEffect(() => () => clearTimeout(session.current?.timer), [])

  const pillHandlers = (index: number) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>): void => {
      if (event.button !== 0 || session.current !== null) return
      if ((event.target as Element).closest("[data-no-drag]") !== null) return
      const current: Session = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        from: index,
        startX: event.clientX,
        startY: event.clientY,
        pill: event.currentTarget,
        timer: undefined,
        centers: null,
        to: index,
      }
      session.current = current
      if (event.pointerType === "touch") {
        current.timer = setTimeout(() => begin(current), HOLD_MS)
      } else {
        // Keep the moves coming once the pointer leaves the pill.
        event.currentTarget.setPointerCapture(event.pointerId)
      }
    },
    onPointerMove: (event: PointerEvent<HTMLElement>): void => {
      const current = session.current
      if (current === null || current.pointerId !== event.pointerId) return
      const dx = event.clientX - current.startX
      const travelled = Math.hypot(dx, event.clientY - current.startY)
      if (current.centers === null) {
        if (current.pointerType === "touch") {
          // Moving before the hold is up is a scroll, not a drag.
          if (travelled > TOUCH_SLOP) end(false)
          return
        }
        if (travelled < MOUSE_SLOP) return
        begin(current)
      }
      current.to = dropIndex(event.clientX, current.centers ?? [], current.from)
      setDrag({ from: current.from, to: current.to, dx })
    },
    onPointerUp: (event: PointerEvent<HTMLElement>): void => {
      if (session.current?.pointerId === event.pointerId) end(true)
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>): void => {
      if (session.current?.pointerId === event.pointerId) end(false)
    },
    // A long press would open the browser's menu over the pill.
    onContextMenu: (event: { preventDefault: () => void }): void => {
      if (session.current?.pointerType === "touch") event.preventDefault()
    },
  })

  return { listRef, drag, pillHandlers }
}
