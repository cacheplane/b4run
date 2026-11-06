import { expect, test } from "vitest"
import { parseCapture } from "../../../lib/turn-inspector/capture-schema"
import {
  initialPlayback,
  nextDelay,
  playbackAction,
  stepIndex,
} from "../../../lib/turn-inspector/playback"
import fixture from "./__fixtures__/synthetic-capture.json"

const capture = parseCapture(JSON.stringify(fixture))
test("seeking pauses and clears future selections", () => {
  let p = playbackAction(capture, initialPlayback(), { type: "seek", index: 5 })
  p = playbackAction(capture, p, { type: "selectActivity", id: "tool-2" })
  p = playbackAction(capture, p, { type: "play" })
  expect(p.playing).toBe(true)
  p = playbackAction(capture, p, { type: "seek", index: 2 })
  expect(p).toMatchObject({ playing: false, index: 2, selectedItemId: null })
})
test("selection never advances playback; terminal tick stops", () => {
  let p = playbackAction(capture, initialPlayback(), { type: "seek", index: 5 })
  p = playbackAction(capture, p, { type: "selectActivity", id: "tool-1" })
  expect(p.index).toBe(5)
  p = playbackAction(capture, p, { type: "play" })
  expect(nextDelay(capture, p)).toBe(100)
  p = playbackAction(capture, p, { type: "tick" })
  expect(p).toMatchObject({ index: 6, playing: false })
  expect(nextDelay(capture, p)).toBeNull()
})
test("steps over text deltas and respects reduced motion", () => {
  expect(stepIndex(capture, 0, 1)).toBe(2)
  expect(stepIndex(capture, 2, -1)).toBe(0)
  expect(playbackAction(capture, initialPlayback(), { type: "play" }, true).playing).toBe(false)
})
