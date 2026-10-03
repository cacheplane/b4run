// @vitest-environment jsdom
import { act } from "react"
import { createRoot, hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { FULL, gsap, REDUCE } from "../motion/gsap"
import { type MediaStub, stubMatchMedia } from "../motion/media-stub"
import { checklist, describeToggle } from "./checklist"
import { LastMile } from "./LastMile"
import { ProductionChecklist } from "./ProductionChecklist"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let media: MediaStub | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
  media?.restore()
  media = undefined
})

const [first, second] = checklist
if (!first || !second) throw new Error("The checklist has items")

function query(container: Element) {
  const q = <T extends Element>(selector: string) => {
    const match = container.querySelector<T>(selector)
    if (!match) throw new Error(`No ${selector}`)
    return match
  }
  return {
    q,
    pressed: () =>
      [...container.querySelectorAll("[data-toggle]")].map((node) =>
        node.getAttribute("aria-pressed"),
      ),
    counter: () => container.querySelector("[data-counter]")?.textContent,
    handled: () => q("[data-done]"),
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
    face: (id: string, face: "chore" | "handled") =>
      q<HTMLElement>(`[data-item="${id}"] [data-face="${face}"]`),
  }
}

async function mount(reduce: boolean) {
  media = stubMatchMedia({ [REDUCE]: reduce, [FULL]: !reduce })
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(<ProductionChecklist />))
  const view = query(container)
  return {
    ...view,
    container,
    toggle: (id: string) =>
      act(async () => view.q<HTMLButtonElement>(`[data-toggle="${id}"]`).click()),
  }
}

it("renders every tile turned over on the server, so each answer is in the page", () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<LastMile />)
  const view = query(container)
  expect(container.querySelector("section#last-mile")?.getAttribute("aria-labelledby")).toBe(
    "last-mile-title",
  )
  expect(view.pressed()).toEqual(checklist.map(() => "true"))
  for (const item of checklist) {
    const answer = view.face(item.id, "handled")
    expect(answer.getAttribute("data-active"), item.id).toBe("true")
    expect(answer.hasAttribute("inert"), item.id).toBe(false)
    expect(answer.textContent, item.id).toContain(item.handledBy)
    expect(answer.textContent, item.id).toContain(item.code)
    expect(answer.querySelector("a")?.getAttribute("href"), item.id).toBe(item.docsHref)
    const chore = view.face(item.id, "chore")
    expect(chore.getAttribute("aria-hidden"), item.id).toBe("true")
    expect(chore.hasAttribute("inert"), item.id).toBe(true)
  }
  expect(view.counter()).toBe("12 of 12 opened")
  expect(view.handled().getAttribute("aria-hidden")).toBeNull()
  expect(container.querySelector("[style]")).toBeNull()
  expect(view.live()).toBe("")
})

it("turns every tile face down once it runs, without announcing anything", async () => {
  const view = await mount(true)
  expect(view.pressed()).toEqual(checklist.map(() => "false"))
  expect(view.counter()).toBe("0 of 12 opened")
  expect(view.handled().getAttribute("aria-hidden")).toBe("true")
  expect(view.face(first.id, "handled").hasAttribute("inert")).toBe(true)
  expect(view.live()).toBe("")
})

it("turns a tile at once, counts it, and announces each turn once", async () => {
  const view = await mount(true)
  await view.toggle(first.id)
  expect(view.q(`[data-toggle="${first.id}"]`).getAttribute("aria-pressed")).toBe("true")
  expect(view.face(first.id, "handled").getAttribute("data-active")).toBe("true")
  expect(view.face(first.id, "chore").hasAttribute("inert")).toBe(true)
  expect(view.counter()).toBe("1 of 12 opened")
  expect(view.live()).toBe(describeToggle(first, true, 1))
  await view.toggle(first.id)
  expect(view.counter()).toBe("0 of 12 opened")
  expect(view.live()).toBe("Tool schemas closed. 0 of 12 opened.")
  // Reduced motion: no tweens at all.
  expect(view.container.querySelectorAll("[data-face]").length).toBe(24)
  expect(
    [...view.container.querySelectorAll("[data-face]")].flatMap((node) => gsap.getTweensOf(node)),
  ).toEqual([])
})

it("says Handled. when all twelve are open, and only then", async () => {
  const view = await mount(true)
  for (const item of checklist) await view.toggle(item.id)
  expect(view.counter()).toBe("12 of 12 opened")
  expect(view.handled().getAttribute("data-done")).toBe("true")
  expect(view.handled().getAttribute("aria-hidden")).toBeNull()
  expect(view.live()).toMatch(/12 of 12 opened\. Handled\.$/)
})

it("flips with rotateY when motion is on, and the next turn kills the flip", async () => {
  const view = await mount(false)
  const fromTo = vi.spyOn(gsap, "fromTo")
  await view.toggle(first.id)
  expect(fromTo).toHaveBeenCalledTimes(1)
  const [target, from, to] = fromTo.mock.calls[0] ?? []
  expect(target).toBe(view.face(first.id, "handled"))
  expect(from).toMatchObject({ rotateY: -90 })
  // .faces sets the perspective; the tween must not apply it a second time.
  expect(from).not.toHaveProperty("transformPerspective")
  expect(to).toMatchObject({ rotateY: 0, duration: 0.3 })
  await view.toggle(second.id)
  expect(view.counter()).toBe("2 of 12 opened")
  const flipped = view.face(first.id, "handled")
  expect(gsap.getTweensOf(flipped)).toEqual([])
  expect(flipped.style.transform).toBe("")
  expect(flipped.style.opacity).toBe("")
})

type Tween = ReturnType<typeof gsap.fromTo>

/** The flip a toggle started, with its kill spied, or a failure if none started. */
function flipOf(fromTo: { mock: { results: { value: unknown }[] } }, index: number) {
  const tween = fromTo.mock.results[index]?.value as Tween | undefined
  if (!tween) throw new Error(`No flip ${index}`)
  return vi.spyOn(tween, "kill")
}

it("swings the front face in when a tile closes", async () => {
  const view = await mount(false)
  const fromTo = vi.spyOn(gsap, "fromTo")
  await view.toggle(first.id)
  await view.toggle(first.id)
  expect(fromTo).toHaveBeenCalledTimes(2)
  expect(fromTo.mock.calls[1]?.[0]).toBe(view.face(first.id, "chore"))
  expect(view.face(first.id, "chore").getAttribute("data-active")).toBe("true")
})

it("stops a flip and clears its styles when reduced motion turns on mid-flip", async () => {
  const view = await mount(false)
  const fromTo = vi.spyOn(gsap, "fromTo")
  await view.toggle(first.id)
  const kill = flipOf(fromTo, 0)
  await act(async () => media?.change({ [REDUCE]: true, [FULL]: false }))
  expect(kill).toHaveBeenCalled()
  const face = view.face(first.id, "handled")
  expect(gsap.getTweensOf(face)).toEqual([])
  expect(face.style.transform).toBe("")
  expect(face.style.opacity).toBe("")
  // And no new flip starts under reduced motion.
  await view.toggle(second.id)
  expect(fromTo).toHaveBeenCalledTimes(1)
})

it("stops a flip and clears its styles when it unmounts mid-flip", async () => {
  const view = await mount(false)
  const fromTo = vi.spyOn(gsap, "fromTo")
  await view.toggle(first.id)
  const kill = flipOf(fromTo, 0)
  const face = view.face(first.id, "handled")
  await act(async () => root?.unmount())
  root = undefined
  expect(kill).toHaveBeenCalled()
  expect(gsap.getTweensOf(face)).toEqual([])
  expect(face.style.transform).toBe("")
})

it("hides Handled. again when a tile closes at twelve", async () => {
  const view = await mount(true)
  for (const item of checklist) await view.toggle(item.id)
  expect(view.handled().getAttribute("aria-hidden")).toBeNull()
  await view.toggle(first.id)
  expect(view.counter()).toBe("11 of 12 opened")
  expect(view.handled().getAttribute("data-done")).toBe("false")
  expect(view.handled().getAttribute("aria-hidden")).toBe("true")
  expect(view.live()).toBe("Tool schemas closed. 11 of 12 opened.")
})

it("keeps focus on the tile's button when a turn would strand it", async () => {
  const view = await mount(true)
  await view.toggle(first.id)
  // Focus on the docs link the next turn hides.
  view.face(first.id, "handled").querySelector("a")?.focus()
  await view.toggle(first.id)
  expect(document.activeElement).toBe(view.q(`[data-toggle="${first.id}"]`))
  // WebKit leaves focus on an ancestor after a click on a button.
  const main = document.createElement("main")
  main.tabIndex = -1
  document.body.replaceChildren(main)
  main.append(view.container)
  main.focus()
  await view.toggle(second.id)
  expect(document.activeElement).toBe(view.q(`[data-toggle="${second.id}"]`))
})

it("moves focus off an answer the first render hides", async () => {
  media = stubMatchMedia({ [REDUCE]: true, [FULL]: false })
  const container = document.createElement("div")
  container.innerHTML = renderToString(<ProductionChecklist />)
  document.body.replaceChildren(container)
  container.querySelector<HTMLAnchorElement>(`[data-item="${second.id}"] a`)?.focus()
  const onRecoverableError = vi.fn()
  const consoleError = vi.spyOn(console, "error")
  await act(async () => {
    root = hydrateRoot(container, <ProductionChecklist />, { onRecoverableError })
  })
  expect(onRecoverableError).not.toHaveBeenCalled()
  expect(consoleError).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(container.querySelector(`[data-toggle="${second.id}"]`))
  expect(query(container).counter()).toBe("0 of 12 opened")
})
