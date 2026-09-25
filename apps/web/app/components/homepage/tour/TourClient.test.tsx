// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DESKTOP, FULL, REDUCE, ScrollTrigger } from "../motion/gsap"
import { type MediaStub, stubMatchMedia } from "../motion/media-stub"
import { TourClient } from "./TourClient"
import { tourStops } from "./tour-stops"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** jsdom has no IntersectionObserver; this one lets a test say which card is in view. */
class FakeIntersectionObserver {
  static latest: FakeIntersectionObserver | undefined
  readonly callback: IntersectionObserverCallback
  readonly targets: Element[] = []
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeIntersectionObserver.latest = this
  }
  observe(target: Element) {
    this.targets.push(target)
  }
  unobserve() {}
  disconnect() {
    this.targets.length = 0
  }
  takeRecords() {
    return []
  }
}

const stops = tourStops.map(({ id, file, state }) => ({ id, file, state }))
let root: Root | undefined
let media: MediaStub | undefined
const scrollIntoView = vi.fn()

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  // jsdom implements neither; the tour only asks the browser to scroll.
  Element.prototype.scrollIntoView = scrollIntoView
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  media?.restore()
  media = undefined
  Reflect.deleteProperty(Element.prototype, "scrollIntoView")
  Reflect.deleteProperty(document, "fonts")
  scrollIntoView.mockReset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount(matching: Readonly<Record<string, boolean>>) {
  media = stubMatchMedia(matching)
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () =>
    root?.render(
      <TourClient stops={stops}>
        {stops.map((stop, index) => (
          <article key={stop.id} id={`tour-${stop.id}`} data-stop={index} tabIndex={-1}>
            <h3>{stop.file}</h3>
          </article>
        ))}
      </TourClient>,
    ),
  )
  const client = container.querySelector<HTMLElement>('[data-tour="root"]')
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  return {
    client,
    tabs,
    cards: () => [...container.querySelectorAll<HTMLElement>("[data-stop]")],
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
    key: (target: Element | undefined, key: string) =>
      act(async () => {
        target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
      }),
  }
}

it("moves through the files with the arrow keys, Home and End, and scrolls to each", async () => {
  const view = await mount({ [REDUCE]: true, [FULL]: false, [DESKTOP]: false })
  expect(view.tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
    "true",
    ...Array(6).fill("false"),
  ])
  expect(view.tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1])
  expect(view.live()).toBe("")

  view.tabs[0]?.focus()
  await view.key(view.tabs[0], "ArrowDown")
  expect(document.activeElement).toBe(view.tabs[1])
  expect(view.tabs[1]?.getAttribute("aria-selected")).toBe("true")
  expect(view.tabs[1]?.tabIndex).toBe(0)
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(view.cards()[1])
  expect(view.live()).toBe("tools/greet.ts, 2 of 7")

  await view.key(view.tabs[1], "End")
  expect(document.activeElement).toBe(view.tabs[6])
  await view.key(view.tabs[6], "ArrowRight")
  expect(document.activeElement).toBe(view.tabs[0])
  await view.key(view.tabs[0], "ArrowUp")
  expect(document.activeElement).toBe(view.tabs[6])
  await view.key(view.tabs[6], "Home")
  expect(document.activeElement).toBe(view.tabs[0])
  expect(view.live()).toBe("index.ts, 1 of 7")
})

it("marks the card in view in the chip bar", async () => {
  const view = await mount({ [REDUCE]: true, [FULL]: false, [DESKTOP]: false })
  const observer = FakeIntersectionObserver.latest
  expect(observer?.targets).toEqual(view.cards())
  const memory = view.cards()[3]
  await act(async () =>
    observer?.callback(
      [{ isIntersecting: true, target: memory } as unknown as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    ),
  )
  const current = [...document.querySelectorAll('[data-tour="chips"] a[aria-current="true"]')]
  expect(current.map((chip) => chip.getAttribute("href"))).toEqual(["#tour-memory"])
  expect(view.live()).toBe("memory.ts, 4 of 7")
})

it("pins only at desktop sizes with motion on, and lets go when motion is reduced", async () => {
  const view = await mount({ [REDUCE]: false, [FULL]: true, [DESKTOP]: false })
  expect(view.client?.dataset.pinned).toBeUndefined()

  await act(async () => media?.change({ [DESKTOP]: true }))
  expect(view.client?.dataset.pinned).toBe("true")
  // Only the current card shows once the stage pins; the others do not overlap it.
  expect(
    view
      .cards()
      .slice(1)
      .map((card) => card.style.visibility),
  ).toEqual(Array(6).fill("hidden"))
  // Each tab names the card it shows. The cards stay <article>s (tabpanel is not
  // an allowed role on <article>).
  expect(view.tabs.map((tab) => tab.getAttribute("aria-controls"))).toEqual(
    view.cards().map((card) => card.id),
  )

  await act(async () => media?.change({ [REDUCE]: true, [FULL]: false }))
  expect(view.client?.dataset.pinned).toBeUndefined()
  // Nothing is left hidden or moved once the pin lets go.
  expect(view.cards().map((card) => card.getAttribute("style") ?? "")).toEqual(Array(7).fill(""))
})

it("re-measures the pin once the web fonts have loaded", async () => {
  // A font swap changes the tour's height, which moves the pin's start, end and snap points.
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  })
  const refresh = vi.spyOn(ScrollTrigger, "refresh").mockImplementation(() => undefined)
  const view = await mount({ [REDUCE]: false, [FULL]: true, [DESKTOP]: true })
  expect(view.client?.dataset.pinned).toBe("true")
  expect(refresh).toHaveBeenCalledTimes(1)
})

it("scrolls smoothly to a chip's card when stacked, and jumps when motion is reduced", async () => {
  const click = (chip: Element | undefined) =>
    act(async () => {
      chip?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
    })
  const chipsOf = () => [...document.querySelectorAll('[data-tour="chips"] a')]

  const moving = await mount({ [REDUCE]: false, [FULL]: true, [DESKTOP]: false })
  await click(chipsOf()[2])
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(moving.cards()[2])
  expect(scrollIntoView.mock.lastCall).toEqual([{ block: "start", behavior: "smooth" }])
  // The URL names the card without a new history entry, and Tab continues inside it.
  expect(location.hash).toBe("#tour-plan")
  expect(document.activeElement).toBe(moving.cards()[2])

  await act(async () => root?.unmount())
  media?.restore()
  const still = await mount({ [REDUCE]: true, [FULL]: false, [DESKTOP]: false })
  await click(chipsOf()[4])
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(still.cards()[4])
  expect(scrollIntoView.mock.lastCall).toEqual([{ block: "start", behavior: "auto" }])
})

it("ignores the cards a chip's smooth scroll passes on its way to the target", async () => {
  const view = await mount({ [REDUCE]: false, [FULL]: true, [DESKTOP]: false })
  const observer = FakeIntersectionObserver.latest
  const seen = (index: number) =>
    act(async () =>
      observer?.callback(
        [
          {
            isIntersecting: true,
            target: view.cards()[index],
          } as unknown as IntersectionObserverEntry,
        ],
        observer as unknown as IntersectionObserver,
      ),
    )
  const currentChips = () =>
    [...document.querySelectorAll('[data-tour="chips"] a[aria-current="true"]')].map((chip) =>
      chip.getAttribute("href"),
    )
  await act(async () => {
    document
      .querySelectorAll('[data-tour="chips"] a')[5]
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
  })
  expect(currentChips()).toEqual(["#tour-subagent"])
  const announced = view.live()

  await seen(2)
  expect(currentChips()).toEqual(["#tour-subagent"])
  expect(view.live()).toBe(announced)

  // Once the target arrives, the observer is back in charge.
  await seen(5)
  await seen(3)
  expect(currentChips()).toEqual(["#tour-memory"])
})

it("names added files for screen readers, and leaves modified clicks to the browser", async () => {
  await mount({ [REDUCE]: true, [FULL]: false, [DESKTOP]: false })
  const chips = [...document.querySelectorAll<HTMLAnchorElement>('[data-tour="chips"] a')]
  const added = chips.filter((_, index) => stops[index]?.state === "added")
  expect(added.length).toBeGreaterThan(0)
  for (const chip of added) expect(chip.querySelector(".sr-only")?.textContent).toBe(" (added)")
  for (const chip of chips.filter((_, index) => stops[index]?.state !== "added")) {
    expect(chip.querySelector(".sr-only")).toBeNull()
  }

  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    metaKey: true,
  })
  // React handles the click at its root, before it bubbles to the document. Record
  // whether React cancelled it there, then cancel it so jsdom does not navigate.
  let prevented: boolean | undefined
  document.addEventListener(
    "click",
    (e) => {
      prevented = e.defaultPrevented
      e.preventDefault()
    },
    { once: true },
  )
  await act(async () => {
    chips[1]?.dispatchEvent(event)
  })
  expect(prevented).toBe(false)
  expect(scrollIntoView).not.toHaveBeenCalled()
})

it("holds the chosen tab while the pinned stage scrolls past the stops between", async () => {
  const create = vi.spyOn(ScrollTrigger, "create")
  const view = await mount({ [REDUCE]: false, [FULL]: true, [DESKTOP]: true })
  const onUpdate = create.mock.calls.at(-1)?.[0].onUpdate
  expect(onUpdate).toBeTypeOf("function")
  const update = (progress: number) =>
    act(async () => onUpdate?.({ progress } as unknown as ScrollTrigger))
  const selected = () => view.tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true")

  await act(async () => view.tabs[6]?.click())
  expect(selected()).toBe(6)
  expect(view.live()).toBe("evals/smoke.eval.ts, 7 of 7")

  await update(2 / 6)
  expect(selected()).toBe(6)
  expect(view.tabs[6]?.tabIndex).toBe(0)
  expect(view.live()).toBe("evals/smoke.eval.ts, 7 of 7")

  // Once the target stop arrives, scrolling drives the tabs again.
  await update(1)
  await update(3 / 6)
  expect(selected()).toBe(3)
})
