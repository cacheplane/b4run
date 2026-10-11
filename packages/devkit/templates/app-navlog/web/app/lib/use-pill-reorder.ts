"use client"
import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react"
import { dropIndex, edgeScrollSpeed } from "./drag-geometry"

/** A drag under way: the pill being moved, where it would land, how far it has travelled. */
export interface PillDrag {
  readonly from: number
  readonly to: number
  /**
   * The pill's horizontal travel since the press, in px, counting any scroll
   * of the row since then: the pill follows it and stays under the pointer.
   */
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
  /** The auto-scroll loop's next frame, while a drag is under way. */
  frame: number | undefined
  /**
   * The pills' horizontal middles when the drag began, in the row's content
   * coordinates (scroll included), so they hold while the row scrolls.
   */
  centers: readonly number[] | null
  /** Where the press was, in the same content coordinates. */
  startContentX: number
  /** The pointer's latest clientX: auto-scroll moves the row under a still pointer. */
  lastX: number
  to: number
}

/** A client x as an x in the row's scrolled content. */
const contentX = (list: HTMLElement, clientX: number): number =>
  clientX - list.getBoundingClientRect().left + list.scrollLeft

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
 * A route longer than the bar scrolls. Held near either end of the row, the
 * dragged pill scrolls it, faster the closer it is to the edge
 * (`edgeScrollSpeed`), so it can reach a place that started out of view.
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
    if (current.frame !== undefined) cancelAnimationFrame(current.frame)
    if (current.pill.hasPointerCapture(current.pointerId)) {
      current.pill.releasePointerCapture(current.pointerId)
    }
    if (current.centers !== null) {
      setDrag(null)
      if (commit && current.to !== current.from) onMoveRef.current(current.from, current.to)
    }
  }, [])

  // Where the pill would land and how far it has travelled, from the
  // pointer's latest position and the row's current scroll.
  const update = useCallback((current: Session): void => {
    const list = listRef.current
    if (list === null || current.centers === null) return
    const x = contentX(list, current.lastX)
    current.to = dropIndex(x, current.centers, current.from)
    setDrag({ from: current.from, to: current.to, dx: x - current.startContentX })
  }, [])

  // One frame of auto-scroll, then the next, for as long as the drag lasts.
  const autoScroll = useCallback(
    (current: Session): void => {
      const list = listRef.current
      if (list === null || session.current !== current) return
      const box = list.getBoundingClientRect()
      const speed = edgeScrollSpeed(current.lastX, box.left, box.right)
      if (speed !== 0) {
        const before = list.scrollLeft
        list.scrollLeft = before + speed
        if (list.scrollLeft !== before) update(current)
      }
      current.frame = requestAnimationFrame(() => autoScroll(current))
    },
    [update],
  )

  const begin = useCallback(
    (current: Session): void => {
      const list = listRef.current
      if (list === null) return
      const box = list.getBoundingClientRect()
      const pills = list.querySelectorAll<HTMLElement>(":scope > li")
      current.centers = [...pills].map((pill) => {
        const rect = pill.getBoundingClientRect()
        return rect.left - box.left + list.scrollLeft + rect.width / 2
      })
      current.startContentX = contentX(list, current.startX)
      if (!current.pill.hasPointerCapture(current.pointerId)) {
        current.pill.setPointerCapture(current.pointerId)
      }
      setDrag({ from: current.from, to: current.from, dx: 0 })
      current.frame = requestAnimationFrame(() => autoScroll(current))
    },
    [autoScroll],
  )

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

  // A drag cut short by an unmount leaves no timer or frame behind.
  useEffect(
    () => () => {
      clearTimeout(session.current?.timer)
      const frame = session.current?.frame
      if (frame !== undefined) cancelAnimationFrame(frame)
    },
    [],
  )

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
        frame: undefined,
        centers: null,
        startContentX: 0,
        lastX: event.clientX,
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
      current.lastX = event.clientX
      const travelled = Math.hypot(event.clientX - current.startX, event.clientY - current.startY)
      if (current.centers === null) {
        if (current.pointerType === "touch") {
          // Moving before the hold is up is a scroll, not a drag.
          if (travelled > TOUCH_SLOP) end(false)
          return
        }
        if (travelled < MOUSE_SLOP) return
        begin(current)
      }
      update(current)
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
