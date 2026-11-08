// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { parseCapture } from "../../../lib/turn-inspector/capture-schema"
import fixture from "./__fixtures__/synthetic-capture.json"
import { DocsVideo } from "./DocsVideo"
import { TurnInspector } from "./TurnInspector"

let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
test("video playback pauses replay, and replay playback pauses video", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root.render(
      <>
        <DocsVideo clip="lesson" />
        <TurnInspector capture={parseCapture(JSON.stringify(fixture))} />
      </>,
    ),
  )
  const video = host.querySelector("video")
  if (!video) throw new Error("Missing video")
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {})
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Play"]')?.click())
  expect(pause).toHaveBeenCalledOnce()
  expect(host.querySelector('button[aria-label="Pause"]')).not.toBeNull()
  await act(async () => video.dispatchEvent(new Event("play")))
  expect(host.querySelector('button[aria-label="Pause"]')).toBeNull()
  expect(host.querySelector('button[aria-label="Play"]')).not.toBeNull()
})
