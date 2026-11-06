"use client"
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { Capture } from "../../../lib/turn-inspector/capture-types"
import type { LessonSource } from "../../../lib/turn-inspector/lesson-types"
import {
  initialPlayback,
  nextDelay,
  type PlaybackAction,
  playbackAction,
} from "../../../lib/turn-inspector/playback"
import { stateAt } from "../../../lib/turn-inspector/replay"
import { ActivityDetails } from "./ActivityDetails"
import { ConversationPane } from "./ConversationPane"
import styles from "./inspector.module.css"
import { PlaybackControls } from "./PlaybackControls"
import { SourcePane } from "./SourcePane"

/** Receives a validated capture. The lesson loader owns artifact fetching. */
export function TurnInspector({
  capture,
  moment,
  sources = [],
  openHref,
  recordingLabel,
}: {
  capture: Capture
  openHref?: string
  recordingLabel?: string
  sources?: LessonSource[]
  moment?: { id: string; request: number }
}) {
  const id = useId()
  const [speed, setSpeed] = useState<0.5 | 1 | 2>(1)
  const [mode, setMode] = useState<"replay" | "source">("replay")
  const heading = useRef<HTMLHeadingElement>(null)
  const [playback, setPlayback] = useState(initialPlayback)
  const [reducedMotion, setReducedMotion] = useState(true)
  const [pane, setPane] = useState<"conversation" | "details">("conversation")
  const [announcement, setAnnouncement] = useState("")
  const [follow, setFollow] = useState(true)
  const conversation = useRef<HTMLDivElement>(null)
  const details = useRef<HTMLElement>(null)
  const focusDetails = useRef(false)
  useLayoutEffect(() => {
    if (!focusDetails.current) return
    focusDetails.current = false
    // Use the applied container-query style, not the viewport width.
    if (conversation.current && getComputedStyle(conversation.current).display === "none")
      details.current?.querySelector<HTMLButtonElement>("button")?.focus()
  })
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    if (!media) return
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  const dispatch = useCallback(
    (action: PlaybackAction) => {
      if (action.type === "play" && !reducedMotion)
        for (const video of document.querySelectorAll("video")) video.pause()
      setPlayback((current) => playbackAction(capture, current, action, reducedMotion))
      if (action.type === "seek") setAnnouncement(`Recorded event ${action.index + 1}`)
    },
    [capture, reducedMotion],
  )
  useEffect(() => {
    const pauseForVideo = (event: Event) => {
      if (event.target instanceof HTMLVideoElement) dispatch({ type: "pause" })
    }
    document.addEventListener("play", pauseForVideo, true)
    return () => document.removeEventListener("play", pauseForVideo, true)
  }, [dispatch])
  // Selection is deliberately absent from the scheduler dependencies.
  useEffect(() => {
    const delay = nextDelay(capture, { index: playback.index, playing: playback.playing }, speed)
    if (delay === null) return
    const timer = setTimeout(() => dispatch({ type: "tick" }), delay)
    return () => clearTimeout(timer)
  }, [capture, playback.index, playback.playing, dispatch, speed])
  useEffect(() => {
    if (reducedMotion) setPlayback((p) => ({ ...p, playing: false }))
  }, [reducedMotion])
  const selectMoment = useCallback(
    (momentId: string) => {
      const target = capture.moments.find((value) => value.id === momentId)
      if (!target) {
        setAnnouncement("That moment is not part of this recording.")
        return
      }
      setPlayback((current) => ({
        ...playbackAction(capture, current, { type: "seek", index: target.eventIndex }),
        selectedItemId: target.itemId ?? null,
        selectedTurnId: null,
      }))
      setPane("conversation")
      setMode("replay")
      setAnnouncement(target.label)
      heading.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" })
      heading.current?.focus({ preventScroll: true })
    },
    [capture],
  )
  useEffect(() => {
    if (moment) selectMoment(moment.id)
  }, [moment, selectMoment])
  const state = useMemo(() => stateAt(capture, playback.index), [capture, playback.index])
  const currentMoment = [...capture.moments].reverse().find((m) => m.eventIndex <= playback.index)
  const momentHash = currentMoment
    ? `#inspect/${encodeURIComponent(capture.id)}/${encodeURIComponent(currentMoment.id)}`
    : ""
  useEffect(() => {
    const el = conversation.current
    if (el && follow && playback.playing && playback.index >= 0) el.scrollTop = el.scrollHeight
  }, [playback.index, playback.playing, follow])
  return (
    <section className={styles.inspector} aria-labelledby={`${id}-title`}>
      <header className={styles.header}>
        <h3 ref={heading} id={`${id}-title`} tabIndex={-1}>
          Turn inspector
        </h3>
        <span>
          {capture.provenance === "synthetic"
            ? "Synthetic test recording"
            : (recordingLabel ?? "Recorded in B4")}
        </span>
        {sources.length > 0 && (
          <fieldset className={styles.toolbar} aria-label="Inspector view">
            <button
              type="button"
              aria-pressed={mode === "replay"}
              onClick={() => setMode("replay")}
            >
              Replay
            </button>
            <button
              type="button"
              aria-pressed={mode === "source"}
              onClick={() => {
                dispatch({ type: "pause" })
                setMode("source")
              }}
            >
              Source
            </button>
          </fieldset>
        )}
        {openHref && (
          <a className={styles.openLink} href={`${openHref}${momentHash}`}>
            Open inspector
          </a>
        )}
      </header>

      {mode === "source" ? (
        <SourcePane sources={sources} moment={currentMoment?.id} />
      ) : (
        <>
          <div className={styles.toolbar}>
            <strong>Conversation</strong>
            <label>
              Turn{" "}
              <select
                value={playback.selectedTurnId ?? ""}
                onChange={(e) => {
                  if (e.target.value) dispatch({ type: "selectTurn", id: e.target.value })
                  else setPlayback((p) => ({ ...p, selectedTurnId: null }))
                }}
              >
                <option value="">All turns</option>
                {state.turns.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className={styles.mobileTabs} aria-label="Inspector pane">
              <button
                type="button"
                aria-pressed={pane === "conversation"}
                onClick={() => setPane("conversation")}
              >
                Conversation
              </button>
              <button
                type="button"
                aria-pressed={pane === "details"}
                onClick={() => setPane("details")}
              >
                Details
              </button>
            </fieldset>
          </div>
          <div className={styles.panes}>
            <div
              ref={conversation}
              className={styles.conversation}
              data-visible={pane === "conversation"}
              onScroll={(e) => {
                const el = e.currentTarget
                setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
              }}
            >
              {state.items.length === 0 && <p>Choose Next event to begin.</p>}
              <ConversationPane
                state={state}
                turnId={playback.selectedTurnId}
                selectedId={playback.selectedItemId}
                onSelect={(itemId) => {
                  focusDetails.current = true
                  dispatch({ type: "selectActivity", id: itemId })
                  setPane("details")
                }}
              />
              {!follow && (
                <button
                  type="button"
                  onClick={() => {
                    setFollow(true)
                    const el = conversation.current
                    if (el) el.scrollTop = el.scrollHeight
                  }}
                >
                  Follow playback
                </button>
              )}
            </div>
            <aside
              ref={details}
              className={styles.details}
              data-visible={pane === "details"}
              aria-label="Activity details"
            >
              <ActivityDetails item={state.items.find((i) => i.id === playback.selectedItemId)} />
            </aside>
          </div>
          <PlaybackControls
            capture={capture}
            playback={playback}
            dispatch={dispatch}
            reducedMotion={reducedMotion}
            speed={speed}
            onSpeed={setSpeed}
            onMoment={selectMoment}
          />
        </>
      )}
      <p className={styles.srOnly} role="status">
        {announcement}
      </p>
    </section>
  )
}
