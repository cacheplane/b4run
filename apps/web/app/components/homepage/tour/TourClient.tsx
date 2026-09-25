"use client"
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { DESKTOP, gsap, REDUCE, ScrollTrigger, withMotion } from "../motion/gsap"
import styles from "./tour.module.css"
import type { TourTab } from "./tour-stops"

const cardsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-stop]")]
const headerHeight = () => document.querySelector("header")?.getBoundingClientRect().height ?? 0

/**
 * Behaviour for the folder tour. The server renders every stop as a stacked
 * card (`children`); this island adds the chip bar's current marker, and, at
 * desktop sizes with motion on, pins the stage with the file tree as a tablist
 * beside one card at a time.
 */
export function TourClient({
  stops,
  children,
}: {
  readonly stops: readonly TourTab[]
  readonly children: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const chipsRef = useRef<HTMLElement>(null)
  const markerRef = useRef<HTMLSpanElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const triggerRef = useRef<ScrollTrigger | null>(null)
  const pinnedRef = useRef(false)
  const activeRef = useRef(0)
  const [active, setActive] = useState(0)
  const [pinned, setPinned] = useState(false)
  const [moved, setMoved] = useState(false)
  const count = stops.length
  const current = stops[active]

  const moveTo = useCallback((index: number) => {
    if (index === activeRef.current) return
    activeRef.current = index
    setActive(index)
    setMoved(true)
  }, [])

  // Pin at desktop sizes with motion on. Otherwise the cards stay stacked.
  useEffect(() => {
    const root = rootRef.current
    const stage = stageRef.current
    if (!root || !stage) return
    return withMotion(
      root,
      {
        reduce: () => {
          root.removeAttribute("data-pinned")
        },
        full: ({ desktop }) => {
          if (!desktop) return undefined
          const cards = cardsOf(root)
          const last = count - 1
          root.setAttribute("data-pinned", "true")
          pinnedRef.current = true
          setPinned(true)
          triggerRef.current = ScrollTrigger.create({
            trigger: stage,
            pin: stage,
            start: () => `top top+=${headerHeight()}`,
            end: () => `+=${count * window.innerHeight * 0.7}`,
            snap: { snapTo: 1 / last, duration: { min: 0.2, max: 0.5 }, ease: "power1.inOut" },
            invalidateOnRefresh: true,
            onUpdate: (self) => moveTo(Math.round(self.progress * last)),
          })
          // A web font swap changes the tour's height; re-measure the pin once fonts load.
          document.fonts?.ready.then(() => {
            if (triggerRef.current) ScrollTrigger.refresh()
          })
          return () => {
            triggerRef.current = null
            pinnedRef.current = false
            setPinned(false)
            const tabs = tabRefs.current.filter((tab): tab is HTMLButtonElement => tab !== null)
            const moving = [...cards, ...tabs, ...(markerRef.current ? [markerRef.current] : [])]
            gsap.killTweensOf(moving)
            gsap.set(moving, { clearProps: "opacity,visibility,transform" })
            root.removeAttribute("data-pinned")
          }
        },
      },
      { desktop: DESKTOP },
    )
  }, [count, moveTo])

  // Stacked: the card crossing the upper middle of the viewport is the current one.
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (pinnedRef.current) return
        for (const entry of entries) {
          if (entry.isIntersecting) moveTo(Number((entry.target as HTMLElement).dataset.stop))
        }
      },
      { rootMargin: "-40% 0px -55% 0px" },
    )
    for (const card of cardsOf(root)) observer.observe(card)
    return () => observer.disconnect()
  }, [moveTo])

  // Keep the current chip in view inside the chip bar (horizontally only).
  useEffect(() => {
    const chips = chipsRef.current
    const chip = chips?.querySelector<HTMLElement>(`[data-chip="${active}"]`)
    if (chips && chip) chips.scrollLeft = Math.max(0, chip.offsetLeft - 16)
  }, [active])

  // Pinned: fade the new card in, slide the marker to its row, settle an added file.
  const activeState = current?.state
  useEffect(() => {
    const root = rootRef.current
    if (!pinned || !root) return
    const cards = cardsOf(root)
    const shown = cards[active]
    const hide = gsap.to(
      cards.filter((card) => card !== shown),
      { autoAlpha: 0, duration: 0.15, overwrite: "auto" },
    )
    const show = shown
      ? gsap.fromTo(
          shown,
          { autoAlpha: 0, y: 12 },
          { autoAlpha: 1, y: 0, duration: 0.3, ease: "power2.out", overwrite: "auto" },
        )
      : undefined
    const tab = tabRefs.current[active]
    const marker = markerRef.current
    const slide =
      tab && marker
        ? gsap.to(marker, {
            y: tab.offsetTop + tab.offsetHeight / 2 - marker.offsetHeight / 2,
            duration: 0.25,
            ease: "power2.out",
          })
        : undefined
    const settle =
      tab && activeState === "added"
        ? gsap.fromTo(tab, { x: -8 }, { x: 0, duration: 0.25, ease: "power2.out" })
        : undefined
    return () => {
      for (const tween of [hide, show, slide, settle]) tween?.kill()
    }
  }, [active, activeState, pinned])

  function goTo(index: number) {
    moveTo(index)
    const trigger = triggerRef.current
    if (trigger) {
      const offset = ((trigger.end - trigger.start) * index) / (count - 1)
      window.scrollTo({ top: trigger.start + offset, behavior: "smooth" })
      return
    }
    const behavior = window.matchMedia(REDUCE).matches ? "auto" : "smooth"
    document
      .getElementById(`tour-${stops[index]?.id}`)
      ?.scrollIntoView({ block: "start", behavior })
  }

  // A plain click on a chip scrolls there smoothly (unless motion is reduced);
  // modified clicks keep the link's own behaviour, and without JS it is a jump link.
  function onChipClick(event: MouseEvent<HTMLAnchorElement>, index: number) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }
    event.preventDefault()
    goTo(index)
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowRight: index + 1,
      ArrowUp: index - 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: count - 1,
    }
    const target = moves[event.key]
    if (target === undefined) return
    event.preventDefault()
    const next = (target + count) % count
    tabRefs.current[next]?.focus()
    goTo(next)
  }

  return (
    <div
      ref={rootRef}
      className={styles.client}
      data-tour="root"
      style={{ "--stops": count } as CSSProperties}
    >
      <nav ref={chipsRef} className={styles.chips} data-tour="chips" aria-label="Jump to a file">
        {stops.map((stop, index) => (
          <a
            key={stop.id}
            href={`#tour-${stop.id}`}
            className={styles.chip}
            data-chip={index}
            aria-current={index === active ? "true" : undefined}
            onClick={(event) => onChipClick(event, index)}
          >
            {stop.state === "added" ? <span aria-hidden="true">+ </span> : null}
            {stop.file}
          </a>
        ))}
      </nav>
      <div ref={stageRef} className={styles.stage} data-tour="stage">
        <div className={styles.tree}>
          <p className={styles.treeRoot}>my-agent/src/app/hello/</p>
          <div className={styles.tabsFrame}>
            <span ref={markerRef} className={styles.marker} aria-hidden="true" />
            <div
              role="tablist"
              aria-label="Files in my-agent/src/app/hello"
              aria-orientation="vertical"
              className={styles.tabs}
            >
              {stops.map((stop, index) => (
                <button
                  key={stop.id}
                  ref={(node) => {
                    tabRefs.current[index] = node
                  }}
                  type="button"
                  role="tab"
                  id={`tour-tab-${stop.id}`}
                  className={styles.tab}
                  aria-selected={index === active}
                  aria-controls={`tour-${stop.id}`}
                  tabIndex={index === active ? 0 : -1}
                  data-state={stop.state}
                  data-settled={stop.state === "scaffolded" || index <= active}
                  onClick={() => goTo(index)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  {stop.state === "added" ? (
                    <span className={styles.plus} aria-hidden="true">
                      +
                    </span>
                  ) : null}
                  {stop.file}
                  <span className="sr-only">
                    {stop.state === "added" ? ", added" : ", scaffolded"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className={styles.cards}>{children}</div>
      </div>
      <p className="sr-only" aria-live="polite">
        {moved && current ? `${current.file}, ${active + 1} of ${count}` : ""}
      </p>
    </div>
  )
}
