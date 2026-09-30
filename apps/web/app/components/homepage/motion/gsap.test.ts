// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { FULL, gsap, type MotionConditions, REDUCE, stopScrollTrigger, withMotion } from "./gsap"
import { type MediaStub, stubMatchMedia } from "./media-stub"

let media: MediaStub | undefined
afterEach(() => {
  media?.restore()
  media = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const box = () => {
  const element = document.createElement("div")
  document.body.append(element)
  return element
}
/** Tweens that take time; `gsap.set` is instant and does not count. */
const moving = (element: Element) =>
  gsap.getTweensOf(element).filter((tween) => tween.duration() > 0)

it("under reduced motion runs only the reduce branch: final state, no tweens", () => {
  media = stubMatchMedia({ [REDUCE]: true, [FULL]: false })
  const element = box()
  const full = vi.fn(() => undefined)
  const stop = withMotion(element, {
    reduce: () => {
      gsap.set(element, { opacity: 0.5 })
    },
    full,
  })
  expect(full).not.toHaveBeenCalled()
  expect(element.style.opacity).toBe("0.5")
  expect(moving(element)).toEqual([])
  stop()
  // The cleanup reverts what the branch did.
  expect(element.style.opacity).toBe("")
})

it("with motion on runs the full branch, and swaps branches when the preference changes", async () => {
  media = stubMatchMedia({ [REDUCE]: false, [FULL]: true, "(min-width: 960px)": true })
  const element = box()
  const cleanup = vi.fn()
  const seen: MotionConditions[] = []
  const stop = withMotion(
    element,
    {
      reduce: (conditions) => {
        seen.push(conditions)
        gsap.set(element, { opacity: 1 })
      },
      full: (conditions) => {
        seen.push(conditions)
        gsap.to(element, { opacity: 0.2, duration: 1 })
        return cleanup
      },
    },
    { wide: "(min-width: 960px)" },
  )
  expect(seen).toEqual([{ wide: true, reduce: false, full: true }])
  expect(moving(element)).toHaveLength(1)

  await media.change({ [REDUCE]: true, [FULL]: false })
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(moving(element)).toEqual([])
  expect(seen.at(-1)).toEqual({ wide: true, reduce: true, full: false })
  expect(element.style.opacity).toBe("1")
  stop()
})

it("registers ScrollTrigger once, however many islands start", async () => {
  media = stubMatchMedia({ [REDUCE]: true, [FULL]: false })
  // The fresh import below brings its own GSAP and ScrollTrigger, and the test
  // setup only reaches the modules loaded last. Stop this copy's first.
  stopScrollTrigger()
  vi.resetModules()
  const fresh = await import("./gsap")
  const register = vi.spyOn(fresh.gsap, "registerPlugin")
  const setup = { reduce: () => undefined, full: () => undefined }
  fresh.withMotion(box(), setup)()
  fresh.withMotion(box(), setup)()
  expect(register).toHaveBeenCalledTimes(1)
  expect(register).toHaveBeenCalledWith(fresh.ScrollTrigger)
  fresh.stopScrollTrigger()
})

it("stops ScrollTrigger's interval, so nothing calls requestAnimationFrame after teardown", async () => {
  media = stubMatchMedia({ [REDUCE]: true, [FULL]: false })
  vi.resetModules()
  const fresh = await import("./gsap")
  fresh.registerScrollTrigger()
  fresh.stopScrollTrigger()
  // Neither the interval nor ScrollTrigger's frame loop calls the global again.
  const raf = vi.spyOn(globalThis, "requestAnimationFrame")
  await new Promise((resolve) => setTimeout(resolve, 600))
  expect(raf).not.toHaveBeenCalled()
})
