import type { Capture } from "./capture-types"
import { stateAt } from "./replay"
export interface Playback {
  index: number
  playing: boolean
  selectedItemId: string | null
  selectedTurnId: string | null
}
export type PlaybackAction =
  | { type: "play" | "pause" | "tick" }
  | { type: "seek"; index: number }
  | { type: "selectActivity" | "selectTurn"; id: string }
export const initialPlayback = (): Playback => ({
  index: -1,
  playing: false,
  selectedItemId: null,
  selectedTurnId: null,
})
export function playbackAction(
  capture: Capture,
  current: Playback,
  action: PlaybackAction,
  reducedMotion = false,
): Playback {
  if (action.type === "pause") return { ...current, playing: false }
  if (action.type === "play")
    return { ...current, playing: !reducedMotion && current.index < capture.events.length - 1 }
  if (action.type === "tick" && !current.playing) return current
  if (action.type === "seek" || action.type === "tick") {
    const index =
      action.type === "seek" ? action.index : Math.min(current.index + 1, capture.events.length - 1)
    const state = stateAt(capture, index)
    return {
      ...current,
      index,
      playing: action.type === "tick" && index < capture.events.length - 1,
      selectedItemId: state.items.some((i) => i.id === current.selectedItemId)
        ? current.selectedItemId
        : null,
      selectedTurnId: state.turns.some((t) => t.id === current.selectedTurnId)
        ? current.selectedTurnId
        : null,
    }
  }
  const state = stateAt(capture, current.index)
  if (action.type === "selectActivity")
    return state.items.some((i) => i.id === action.id)
      ? { ...current, selectedItemId: action.id }
      : current
  if (action.type === "selectTurn")
    return state.turns.some((t) => t.id === action.id)
      ? { ...current, selectedTurnId: action.id }
      : current
  return current
}
/** One UI timer consumes this delay; selection never resets it. */
export function nextDelay(
  capture: Capture,
  playback: Pick<Playback, "index" | "playing">,
): number | null {
  if (!playback.playing) return null
  const next = capture.events[playback.index + 1]
  return next
    ? Math.max(0, next.elapsedMs - (capture.events[playback.index]?.elapsedMs ?? 0))
    : null
}
export function stepIndex(capture: Capture, index: number, direction: 1 | -1): number {
  for (let i = index + direction; i >= 0 && i < capture.events.length; i += direction) {
    if (capture.events[i]!.changes.some((c) => c.kind !== "delta")) return i
  }
  return direction === -1 ? -1 : capture.events.length - 1
}
