import type { CSSProperties } from "react"
import type { Capture } from "../../../lib/turn-inspector/capture-types"
import type { Playback, PlaybackAction } from "../../../lib/turn-inspector/playback"
import { stepIndex, turnIndex, turnStarts } from "../../../lib/turn-inspector/playback"
import { InspectorIcon } from "./InspectorIcon"
import styles from "./inspector.module.css"
export function PlaybackControls({
  capture,
  playback,
  dispatch,
  reducedMotion,
  speed,
  onSpeed,
  onMoment,
}: {
  capture: Capture
  playback: Playback
  dispatch: (action: PlaybackAction) => void
  reducedMotion: boolean
  speed: 0.5 | 1 | 2
  onSpeed: (speed: 0.5 | 1 | 2) => void
  onMoment: (id: string) => void
}) {
  const starts = turnStarts(capture),
    total = capture.events.length
  const current = [...capture.moments].reverse().find((m) => m.eventIndex <= playback.index)
  const elapsed = capture.events[playback.index]?.elapsedMs ?? 0,
    duration = capture.events.at(-1)?.elapsedMs ?? 0
  const seek = (index: number) => dispatch({ type: "seek", index })
  return (
    <div className={styles.controls} data-player="true">
      <div className={styles.transport}>
        <button
          type="button"
          aria-label="Previous turn"
          title="Previous turn"
          disabled={playback.index < 0}
          onClick={() => seek(turnIndex(capture, playback.index, -1))}
        >
          <InspectorIcon name="first" />
        </button>
        <button
          type="button"
          aria-label="Previous event"
          title="Previous event"
          disabled={playback.index < 0}
          onClick={() => seek(stepIndex(capture, playback.index, -1))}
        >
          <InspectorIcon name="previous" />
        </button>
        <button
          type="button"
          className={styles.play}
          aria-label={playback.playing ? "Pause" : "Play"}
          title={
            reducedMotion
              ? "Reduced motion: use event controls"
              : playback.playing
                ? "Pause"
                : "Play"
          }
          disabled={reducedMotion || playback.index === total - 1}
          onClick={() => dispatch({ type: playback.playing ? "pause" : "play" })}
        >
          <InspectorIcon name={playback.playing ? "pause" : "play"} />
        </button>
        <button
          type="button"
          aria-label="Next event"
          title="Next event"
          disabled={playback.index === total - 1}
          onClick={() => seek(stepIndex(capture, playback.index, 1))}
        >
          <InspectorIcon name="next" />
        </button>
        <button
          type="button"
          aria-label="Next turn"
          title="Next turn"
          disabled={playback.index === total - 1}
          onClick={() => seek(turnIndex(capture, playback.index, 1))}
        >
          <InspectorIcon name="last" />
        </button>
      </div>
      <div className={styles.timeline}>
        <div className={styles.timelineCaption}>
          <span>{current?.label ?? "Ready to explore"}</span>
          <span>
            {playback.index + 1} / {total}
          </span>
        </div>
        <input
          className={styles.scrubber}
          type="range"
          aria-label="Recorded event"
          aria-valuetext={`Event ${playback.index + 1} of ${total}`}
          min={-1}
          max={total - 1}
          value={playback.index}
          style={
            {
              "--progress": `${((playback.index + 1) / Math.max(total, 1)) * 100}%`,
            } as CSSProperties
          }
          onChange={(e) => seek(Number(e.target.value))}
        />
        <div className={styles.turnSegments}>
          {starts.map((turn, i) => (
            <span key={turn.id} style={{ flex: (starts[i + 1]?.index ?? total) - turn.index }}>
              Turn {i + 1}
            </span>
          ))}
        </div>
        {capture.moments.length > 0 && (
          <fieldset className={styles.moments} aria-label="Recorded moments">
            {capture.moments.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onMoment(m.id)}
                aria-label={`Inspect ${m.label}`}
                title={m.label}
                aria-pressed={m.id === current?.id}
              >
                <span className={styles.momentName}>{m.label}</span>
              </button>
            ))}
          </fieldset>
        )}
      </div>
      <div className={styles.playerMeta}>
        <span className={styles.clock}>
          {(elapsed / 1000).toFixed(1)} / {(duration / 1000).toFixed(1)} s
        </span>
        <button
          type="button"
          aria-label={`Playback speed ${speed}×`}
          onClick={() => onSpeed(speed === 0.5 ? 1 : speed === 1 ? 2 : 0.5)}
        >
          {speed}×
        </button>
      </div>
    </div>
  )
}
