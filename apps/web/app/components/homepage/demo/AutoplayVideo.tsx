"use client"
import { type ReactNode, useEffect, useRef } from "react"
import { REDUCE } from "../motion/gsap"

/** How much of the video has to be on screen before it plays. */
const VISIBLE = 0.5

interface AutoplayVideoProps {
  readonly className?: string | undefined
  readonly poster: string
  readonly width: number
  readonly height: number
  readonly ariaLabel: string
  /** The `<source>` elements. */
  readonly children: ReactNode
}

/**
 * A muted video that plays while half of it is on screen and pauses when it
 * scrolls away. Browsers only autoplay muted video; this recording has no
 * audio, so nothing is lost.
 *
 * The visitor's choice wins: once they pause it, or it plays to the end,
 * scrolling never starts it again, though the controls still do. Nothing
 * plays by itself under prefers-reduced-motion, and `preload="none"` keeps
 * the page to the poster until the video is first in view.
 */
export function AutoplayVideo({
  className,
  poster,
  width,
  height,
  ariaLabel,
  children,
}: AutoplayVideoProps) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = ref.current
    if (video === null || typeof IntersectionObserver === "undefined") return
    if (window.matchMedia(REDUCE).matches) return
    // Set when the visitor pauses it or it ends; cleared when they play it.
    let held = false
    // Our own pause, on scrolling away, is not the visitor's.
    let pausing = false
    const onPause = () => {
      if (pausing) pausing = false
      else held = true
    }
    const onPlay = () => {
      held = false
    }
    const onEnded = () => {
      held = true
    }
    video.addEventListener("pause", onPause)
    video.addEventListener("play", onPlay)
    video.addEventListener("ended", onEnded)
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry === undefined) return
        if (entry.isIntersecting) {
          if (held || !video.paused) return
          video.muted = true
          video.play().catch(() => undefined)
        } else if (!video.paused) {
          pausing = true
          video.pause()
        }
      },
      { threshold: VISIBLE },
    )
    observer.observe(video)
    return () => {
      observer.disconnect()
      video.removeEventListener("pause", onPause)
      video.removeEventListener("play", onPlay)
      video.removeEventListener("ended", onEnded)
    }
  }, [])

  return (
    <video
      ref={ref}
      className={className}
      controls
      muted
      playsInline
      preload="none"
      poster={poster}
      width={width}
      height={height}
      aria-label={ariaLabel}
    >
      {children}
    </video>
  )
}
