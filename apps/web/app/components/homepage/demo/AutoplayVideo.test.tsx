// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AutoplayVideo } from "./AutoplayVideo"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** jsdom has no IntersectionObserver; this one lets a test scroll the video in and out. */
class FakeIntersectionObserver {
  static latest: FakeIntersectionObserver | undefined
  readonly callback: IntersectionObserverCallback
  readonly options: IntersectionObserverInit | undefined
  target: Element | undefined
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
    FakeIntersectionObserver.latest = this
  }
  observe(target: Element) {
    this.target = target
  }
  disconnect() {}
}

let root: Root | undefined
let reduced = false

beforeEach(() => {
  FakeIntersectionObserver.latest = undefined
  reduced = false
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: reduced && query.includes("reduce"), media: query })),
  )
  // jsdom implements neither; each flips `paused` and fires its event, as a browser does.
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    return (this as HTMLMediaElement & { _playing?: boolean })._playing !== true
  })
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    ;(this as HTMLMediaElement & { _playing?: boolean })._playing = true
    this.dispatchEvent(new Event("play"))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    ;(this as HTMLMediaElement & { _playing?: boolean })._playing = false
    this.dispatchEvent(new Event("pause"))
  })
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const mount = async () => {
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root?.render(
      <AutoplayVideo poster="/poster.webp" width={1440} height={810} ariaLabel="demo">
        <source src="/demo.mp4" type="video/mp4" />
      </AutoplayVideo>,
    ),
  )
  const video = container.querySelector("video") as HTMLVideoElement
  const scroll = (inView: boolean) =>
    act(async () => {
      const observer = FakeIntersectionObserver.latest
      observer?.callback(
        [{ isIntersecting: inView, target: video } as unknown as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      )
    })
  return { video, scroll }
}

it("waits off screen, then plays muted once half of it is in view", async () => {
  const { video, scroll } = await mount()
  expect(FakeIntersectionObserver.latest?.options?.threshold).toBe(0.5)
  expect(video.getAttribute("preload")).toBe("none")
  expect(video.hasAttribute("controls")).toBe(true)
  expect(video.play).not.toHaveBeenCalled()
  await scroll(true)
  expect(video.play).toHaveBeenCalledTimes(1)
  expect(video.muted).toBe(true)
})

it("pauses when it scrolls away and resumes when it comes back", async () => {
  const { video, scroll } = await mount()
  await scroll(true)
  await scroll(false)
  expect(video.paused).toBe(true)
  await scroll(true)
  expect(video.play).toHaveBeenCalledTimes(2)
  expect(video.paused).toBe(false)
})

it("stays paused after the visitor pauses it, until they play it again", async () => {
  const { video, scroll } = await mount()
  await scroll(true)
  await act(async () => video.pause())
  await scroll(false)
  await scroll(true)
  expect(video.play).toHaveBeenCalledTimes(1)
  // Pressing play hands it back: it pauses and resumes with the scroll again.
  await act(async () => video.play())
  await scroll(false)
  await scroll(true)
  expect(video.play).toHaveBeenCalledTimes(3)
})

it("does not start over after it plays to the end", async () => {
  const { video, scroll } = await mount()
  await scroll(true)
  await act(async () => {
    ;(video as HTMLVideoElement & { _playing?: boolean })._playing = false
    video.dispatchEvent(new Event("pause"))
    video.dispatchEvent(new Event("ended"))
  })
  await scroll(false)
  await scroll(true)
  expect(video.play).toHaveBeenCalledTimes(1)
})

it("never plays by itself when the visitor prefers reduced motion", async () => {
  reduced = true
  const { video } = await mount()
  expect(FakeIntersectionObserver.latest).toBeUndefined()
  expect(video.play).not.toHaveBeenCalled()
})
