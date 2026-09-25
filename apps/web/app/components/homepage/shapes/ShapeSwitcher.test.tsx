// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it } from "vitest"
import { FULL, gsap, REDUCE } from "../motion/gsap"
import { type MediaStub, stubMatchMedia } from "../motion/media-stub"
import { prepareRouteShapes } from "./prepare"
import { RouteShapes } from "./RouteShapes"
import { ShapeSwitcher } from "./ShapeSwitcher"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let media: MediaStub | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  media?.restore()
  media = undefined
})

const code = await prepareRouteShapes()

async function mount(reduce: boolean) {
  media = stubMatchMedia({ [REDUCE]: reduce, [FULL]: !reduce })
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(<ShapeSwitcher code={code} />))
  const radio = (id: string) => {
    const match = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${id}"]`)
    if (!match) throw new Error(`No radio for ${id}`)
    return match
  }
  const visible = () =>
    [...container.querySelectorAll('[data-active="true"]')].map((node) =>
      node.getAttribute("data-shape"),
    )
  return {
    container,
    pick: (id: string) => act(async () => radio(id).click()),
    checked: () => container.querySelector<HTMLInputElement>("input:checked")?.value,
    visible,
    code: () => container.querySelector('pre[data-active="true"]')?.textContent ?? "",
    hiddenAreInert: () =>
      [...container.querySelectorAll('[data-shape]:not([data-active="true"])')].every(
        (node) => node.getAttribute("aria-hidden") === "true" && node.hasAttribute("inert"),
      ),
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
    fading: () =>
      [...container.querySelectorAll("[data-shape]")].flatMap((node) =>
        gsap.getTweensOf(node).filter((tween) => tween.duration() > 0 && tween.isActive()),
      ),
  }
}

it("renders every shape on the server, with the agent showing and nothing announced", async () => {
  const html = renderToString(<RouteShapes code={code} />)
  const container = document.createElement("div")
  container.innerHTML = html
  expect(container.querySelector("section#route-shapes")?.getAttribute("aria-labelledby")).toBe(
    "route-shapes-title",
  )
  expect(container.querySelector("fieldset legend")?.textContent).toBe("Route shape")
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((input) => [
      input.value,
      input.checked,
    ]),
  ).toEqual([
    ["agent", true],
    ["workflow", false],
    ["graph", false],
    ["chain", false],
  ])
  const pres = [...container.querySelectorAll("pre[data-shape]")]
  expect(pres.map((pre) => pre.getAttribute("data-shape"))).toEqual([
    "agent",
    "workflow",
    "graph",
    "chain",
  ])
  expect(pres[0]?.textContent).toContain("export default agent({")
  expect(pres[2]?.textContent).toContain("export const graph = new StateGraph(Hello)")
  // No element starts hidden by an inline style: the no-JS page is complete.
  expect(container.querySelector("[style]")).toBeNull()
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("")
})

it("switches the shape at once, announces it, and keeps the others inert", async () => {
  const view = await mount(true)
  expect(view.checked()).toBe("agent")
  expect(view.live()).toBe("")
  await view.pick("graph")
  expect(view.checked()).toBe("graph")
  expect(view.visible()).toEqual(["graph", "graph"])
  expect(view.code()).toContain("new StateGraph(Hello)")
  expect(view.hiddenAreInert()).toBe(true)
  expect(view.live()).toBe(
    "Showing src/app/hello/index.ts as a graph. Raw LangGraph, with your own state, nodes and edges.",
  )
  // Reduced motion: the final state, and nothing moving.
  expect(view.fading()).toEqual([])
})

it("fades the new shape in with motion on, and a quick second pick replaces the fade", async () => {
  const view = await mount(false)
  await view.pick("workflow")
  expect(view.fading().length).toBeGreaterThan(0)
  await view.pick("chain")
  // The semantic state is final at once, whatever the fade is doing.
  expect(view.checked()).toBe("chain")
  expect(view.visible()).toEqual(["chain", "chain"])
  expect(view.live()).toBe(
    "Showing src/app/hello/index.ts as a chain. One LangChain chain that runs its steps in order.",
  )
  const workflow = [...view.container.querySelectorAll('[data-shape="workflow"]')]
  expect(workflow.flatMap((node) => gsap.getTweensOf(node))).toEqual([])
  expect(workflow.every((node) => (node as HTMLElement).style.opacity === "")).toBe(true)
})
