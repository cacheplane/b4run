// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { recordingEnv } from "../../../../scripts/export-homepage-demos.mjs"
import { FULL, gsap, REDUCE } from "../motion/gsap"
import { type MediaStub, stubMatchMedia } from "../motion/media-stub"
import { DeployTargets } from "./DeployTargets"
import { prepareDeployTargets } from "./prepare"
import { deployTargets, describeTarget, testReplay } from "./ship-data"
import { TestAndShip } from "./TestAndShip"
import { TestReplay } from "./TestReplay"

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

const code = await prepareDeployTargets()
const [testRun, evalRun] = testReplay.runs
if (!testRun || !evalRun) throw new Error("The recording has two runs")

async function mount(node: React.ReactNode, reduce: boolean) {
  media = stubMatchMedia({ [REDUCE]: reduce, [FULL]: !reduce })
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(node))
  const q = <T extends Element>(selector: string) => {
    const match = container.querySelector<T>(selector)
    if (!match) throw new Error(`No ${selector}`)
    return match
  }
  return {
    container,
    q,
    press: (selector: string) => act(async () => q<HTMLButtonElement>(selector).click()),
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
    tweensOn: (selector: string) =>
      [...container.querySelectorAll(selector)].flatMap((node) => gsap.getTweensOf(node)),
    styled: (selector: string) =>
      [...container.querySelectorAll<HTMLElement>(selector)].filter(
        (node) => node.style.opacity !== "" || node.style.transform !== "",
      ),
  }
}

it("renders both halves complete on the server, with nothing announced", () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<TestAndShip code={code} />)
  const section = container.querySelector("section#test-and-ship")
  expect(section?.getAttribute("aria-labelledby")).toBe("test-and-ship-title")
  // Every recorded line is in the log, which is a log but not a live region.
  const log = container.querySelector('[role="log"]')
  expect(log?.getAttribute("aria-live")).toBe("off")
  for (const run of testReplay.runs) {
    expect(log?.textContent).toContain(run.command)
    for (const line of run.lines.filter(Boolean)) expect(log?.textContent).toContain(line)
  }
  expect(
    [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((input) => [
      input.value,
      input.checked,
    ]),
  ).toEqual(deployTargets.map((target) => [target.id, target.id === "node"]))
  const panels = [...container.querySelectorAll("[data-target]")]
  expect(panels.map((panel) => panel.getAttribute("data-target"))).toEqual(
    deployTargets.map((target) => target.id),
  )
  expect(panels[0]?.textContent).toContain('build: { targets: ["node"] },')
  expect(panels[0]?.textContent).toContain("wrote .b4/build/server.mjs")
  expect(panels.at(-1)?.textContent).toContain("helm install b4-app")
  expect(panels.slice(1).every((panel) => panel.getAttribute("aria-hidden") === "true")).toBe(true)
  expect(container.textContent).toContain("Setting build.targets replaces them.")
  // No element starts hidden by an inline style: the no-JS page is complete.
  expect(container.querySelector("[style]")).toBeNull()
  // ui.css pads every `pre [data-line]` for docs code blocks; the log must not match it.
  expect(container.querySelector("pre [data-line]")).toBeNull()
  expect(
    [...container.querySelectorAll('[aria-live="polite"]')].map((node) => node.textContent),
  ).toEqual(["", ""])
})

it("records with no model key, whatever the shell has set", () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-not-a-real-key")
  expect(recordingEnv()).not.toHaveProperty("OPENAI_API_KEY")
  vi.unstubAllEnvs()
})

it("announces a replay once, at once, and words a repeat differently", async () => {
  const view = await mount(<TestReplay />, true)
  expect(view.live()).toBe("")
  await view.press('[data-replay="test"]')
  expect(view.live()).toBe("Replayed npm test -- --reporter=verbose. Tests 1 passed (1).")
  await view.press('[data-replay="test"]')
  expect(view.live()).toBe("Replayed npm test -- --reporter=verbose again. Tests 1 passed (1).")
  await view.press('[data-replay="eval"]')
  expect(view.live()).toBe("Replayed npx b4 eval. PASS greets by name mean=1.00.")
  // Reduced motion: every line shows, and nothing moves.
  expect(view.tweensOn("[data-replay-line]")).toEqual([])
  expect(view.styled("[data-replay-line]")).toEqual([])
})

it("streams the lines in with motion on, and Skip or the next replay shows them all", async () => {
  const view = await mount(<TestReplay />, false)
  const fromTo = vi.spyOn(gsap, "fromTo")
  await view.press('[data-replay="test"]')
  // Assert the stream started, not that it is still running.
  expect(fromTo).toHaveBeenCalledTimes(1)
  const [targets, from, to] = fromTo.mock.calls[0] ?? []
  expect([...(targets as NodeListOf<Element>)]).toEqual([
    ...view.container.querySelectorAll('[data-run="test"] [data-replay-line]'),
  ])
  expect(targets as NodeListOf<Element>).toHaveLength(testRun.lines.length)
  expect(from).toEqual({ opacity: 0 })
  expect((to as gsap.TweenVars).stagger).toBe(0.08)
  await view.press('[data-action="skip"]')
  expect(view.tweensOn('[data-run="test"] [data-replay-line]')).toEqual([])
  expect(view.styled('[data-run="test"] [data-replay-line]')).toEqual([])
  expect(view.live()).toBe("Replayed npm test -- --reporter=verbose. Tests 1 passed (1).")

  await view.press('[data-replay="test"]')
  await view.press('[data-replay="eval"]')
  expect(fromTo).toHaveBeenCalledTimes(3)
  expect(view.tweensOn('[data-run="test"] [data-replay-line]')).toEqual([])
  expect(view.styled('[data-run="test"] [data-replay-line]')).toEqual([])
  expect(view.live()).toBe("Replayed npx b4 eval. PASS greets by name mean=1.00.")
})

it("puts focus on a replay button when a click leaves it on an ancestor", async () => {
  const view = await mount(<TestReplay />, true)
  const main = document.createElement("main")
  main.tabIndex = -1
  document.body.replaceChildren(main)
  main.append(view.container)
  main.focus()
  await view.press('[data-replay="eval"]')
  expect(document.activeElement).toBe(view.q('[data-replay="eval"]'))
  main.focus()
  await view.press('[data-action="skip"]')
  expect(document.activeElement).toBe(view.q('[data-action="skip"]'))
})

it("switches the deploy target at once, announces it, and keeps the others inert", async () => {
  const view = await mount(<DeployTargets code={code} />, true)
  await act(async () => view.q<HTMLInputElement>('input[value="hono"]').click())
  expect(view.container.querySelector<HTMLInputElement>("input:checked")?.value).toBe("hono")
  const active = view.q('[data-target][data-active="true"]')
  expect(active.getAttribute("data-target")).toBe("hono")
  expect(active.textContent).toContain("wrote wrangler.toml")
  expect(
    [...view.container.querySelectorAll('[data-target]:not([data-active="true"])')].every(
      (node) => node.getAttribute("aria-hidden") === "true" && node.hasAttribute("inert"),
    ),
  ).toBe(true)
  const hono = deployTargets.find((target) => target.id === "hono")
  if (!hono) throw new Error("No hono target")
  expect(view.live()).toBe(describeTarget(hono))
  expect(view.tweensOn("[data-target]")).toEqual([])
})

it("fades a target in with motion on, and the next pick kills the fade", async () => {
  const view = await mount(<DeployTargets code={code} />, false)
  const fromTo = vi.spyOn(gsap, "fromTo")
  await act(async () => view.q<HTMLInputElement>('input[value="vercel"]').click())
  expect(fromTo).toHaveBeenCalledTimes(1)
  const [faded] = fromTo.mock.calls[0] ?? []
  expect((faded as Element).getAttribute("data-target")).toBe("vercel")
  await act(async () => view.q<HTMLInputElement>('input[value="kubernetes"]').click())
  expect(view.q('[data-target][data-active="true"]').getAttribute("data-target")).toBe("kubernetes")
  expect(view.tweensOn('[data-target="vercel"]')).toEqual([])
  expect(view.styled('[data-target="vercel"]')).toEqual([])
})

it("gives focus to the checked radio when a click leaves it on an ancestor", async () => {
  const view = await mount(<DeployTargets code={code} />, true)
  // WebKit moves focus on mousedown to the nearest focusable ancestor.
  const main = document.createElement("main")
  main.tabIndex = -1
  document.body.replaceChildren(main)
  main.append(view.container)
  main.focus()
  await act(async () => view.q<HTMLInputElement>('input[value="langsmith"]').click())
  expect(document.activeElement).toBe(view.q('input[value="langsmith"]'))
  // Focus already in the group stays where the visitor put it.
  view.q<HTMLInputElement>('input[value="langsmith"]').focus()
  await act(async () => view.q<HTMLInputElement>('input[value="node"]').click())
  expect(document.activeElement).toBe(view.q('input[value="langsmith"]'))
})
