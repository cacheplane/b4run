import type { Capture } from "../../../lib/turn-inspector/capture-types"
import type { Playback, PlaybackAction } from "../../../lib/turn-inspector/playback"
import { stepIndex } from "../../../lib/turn-inspector/playback"
import styles from "./inspector.module.css"
export function PlaybackControls({
  capture,
  playback,
  dispatch,
  reducedMotion,
}: {
  capture: Capture
  playback: Playback
  dispatch: (action: PlaybackAction) => void
  reducedMotion: boolean
}) {
  return (
    <div className={styles.controls}>
      <button
        type="button"
        disabled={playback.index < 0}
        onClick={() => dispatch({ type: "seek", index: stepIndex(capture, playback.index, -1) })}
      >
        Previous event
      </button>
      {!reducedMotion && (
        <button
          type="button"
          disabled={playback.index === capture.events.length - 1}
          onClick={() => dispatch({ type: playback.playing ? "pause" : "play" })}
        >
          {playback.playing ? "Pause" : "Play"}
        </button>
      )}
      <button
        type="button"
        disabled={playback.index === capture.events.length - 1}
        onClick={() => dispatch({ type: "seek", index: stepIndex(capture, playback.index, 1) })}
      >
        Next event
      </button>
      <label className={styles.scrubber}>
        Recorded event
        <input
          type="range"
          min={-1}
          max={capture.events.length - 1}
          value={playback.index}
          onChange={(e) => dispatch({ type: "seek", index: Number(e.target.value) })}
        />
      </label>
      <span className={styles.clock}>
        {playback.index + 1}/{capture.events.length} ·{" "}
        {((capture.events[playback.index]?.elapsedMs ?? 0) / 1000).toFixed(1)}s
      </span>
    </div>
  )
}
