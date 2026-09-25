// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { FULL, gsap, REDUCE } from "../motion/gsap"
import { type MediaStub, stubMatchMedia } from "../motion/media-stub"
import { GateTracer } from "./GateTracer"
import { Guardrails } from "./Guardrails"
import { describeBoard, gateBoards } from "./gate-scenarios"
import { prepareGates } from "./prepare"

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

const data = await prepareGates()
const say = (id: string) => {
  const board = gateBoards.find((candidate) => candidate.id === id)
  if (!board) throw new Error(`No board ${id}`)
  return describeBoard(board)
}

async function mount(reduce: boolean) {
  media = stubMatchMedia({ [REDUCE]: reduce, [FULL]: !reduce })
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(<GateTracer {...data} />))
  const radio = (id: string) => {
    const match = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${id}"]`)
    if (!match) throw new Error(`No radio for ${id}`)
    return match
  }
  const activeBoard = () => container.querySelector('[data-board][data-active="true"]')
  const button = (selector: string) => {
    const match = activeBoard()?.querySelector<HTMLButtonElement>(selector)
    if (!match) throw new Error(`No ${selector} on the active board`)
    return match
  }
  return {
    container,
    radio,
    pick: (id: string) => act(async () => radio(id).click()),
    // What a browser does for an arrow key in a radio group: keydown on the
    // focused radio, then focus and check the next one, then keyup there.
    arrowTo: (id: string) =>
      act(async () => {
        const from = document.activeElement ?? container
        from.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
        radio(id).focus()
        radio(id).click()
        radio(id).dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }))
      }),
    press: (selector: string) => act(async () => button(selector).click()),
    board: () => activeBoard()?.getAttribute("data-board"),
    states: () =>
      [...(activeBoard()?.querySelectorAll("[data-gate]") ?? [])].map(
        (gate) => `${gate.getAttribute("data-gate")}:${gate.getAttribute("data-state")}`,
      ),
    file: () =>
      container.querySelector('[data-file][data-active="true"]')?.getAttribute("data-file"),
    marked: () =>
      [...container.querySelectorAll('[data-file][data-active="true"] [data-why="true"]')].map(
        (line) => (line.textContent ?? "").replace(/^›/, "").trim(),
      ),
    hiddenAreInert: () =>
      [
        ...container.querySelectorAll(
          '[data-board]:not([data-active="true"]), [data-file]:not([data-active="true"]), [data-scenario]:not([data-active="true"])',
        ),
      ].every((node) => node.getAttribute("aria-hidden") === "true" && node.hasAttribute("inert")),
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
    focused: () => document.activeElement?.textContent,
    moving: () =>
      [...container.querySelectorAll("[data-gate], [data-result]")].flatMap((node) =>
        gsap.getTweensOf(node).filter((tween) => tween.duration() > 0),
      ),
    styled: () =>
      [...container.querySelectorAll<HTMLElement>("[data-gate], [data-result]")].filter(
        (node) => node.style.opacity !== "" || node.style.transform !== "",
      ).length,
  }
}

it("renders the section on the server with the first call traced and nothing announced", () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<Guardrails {...data} />)
  const section = container.querySelector("section#guardrails")
  expect(section?.getAttribute("aria-labelledby")).toBe("guardrails-title")
  expect(section?.querySelector("h2")?.textContent).toBe("Four checks decide what a call can do.")
  expect(section?.querySelector("fieldset legend")?.textContent).toBe(
    "Pick a call the support agent makes",
  )
  const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  expect(radios.map((radio) => [radio.value, radio.checked])).toEqual([
    ["read", true],
    ["refund", false],
    ["bash", false],
    ["delete", false],
    ["delegate", false],
  ])
  // Every board is in the page; only the first shows.
  expect([...container.querySelectorAll("[data-board]")]).toHaveLength(gateBoards.length)
  const shown = container.querySelector('[data-board][data-active="true"]')
  expect(shown?.getAttribute("data-board")).toBe("read")
  expect(shown?.textContent).toContain("1 · Tool scope")
  expect(shown?.textContent).toContain("passed")
  expect(shown?.textContent).toContain("readFile runs inside the sandbox, and no one is asked.")
  expect(container.querySelector("[style]")).toBeNull()
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("")
  expect(section?.querySelector('a[href="/docs/access-control#how-they-compose"]')).not.toBeNull()
})

it("traces a call at once: states, config, marks and one announcement", async () => {
  const view = await mount(true)
  expect(view.board()).toBe("read")
  expect(view.live()).toBe("")
  expect(view.hiddenAreInert()).toBe(true)

  await view.pick("delegate")
  expect(view.board()).toBe("delegate")
  expect(view.states()).toEqual([
    "scope:skipped",
    "permission:skipped",
    "sandbox:skipped",
    "delegation:stopped",
  ])
  expect(view.file()).toBe("route")
  expect(view.marked()).toEqual([
    'input.length <= 2_000 || "Send the translator one reply at a time."',
    'rules: { translator: { action: "constrain", predicate: oneReply } },',
  ])
  expect(view.live()).toBe(
    'task({ subagent: "translator", … }): Delegation stopped. task returns "[B4_E3002] Send the translator one reply at a time." translator never starts.',
  )
  expect(view.hiddenAreInert()).toBe(true)

  await view.pick("delete")
  expect(view.states()).toEqual([
    "scope:stopped",
    "permission:unreached",
    "sandbox:unreached",
    "delegation:unreached",
  ])
  expect(view.file()).toBe("route")
  expect(view.marked()).toEqual(['deny: ["deleteUser"],'])
  expect(view.live()).toBe(say("delete"))
  // Neither call pauses, so nothing moves focus to a button.
  expect(document.activeElement?.tagName).not.toBe("BUTTON")
  // Reduced motion: final state, nothing moving, no inline styles left.
  expect(view.moving()).toEqual([])
  expect(view.styled()).toBe(0)
})

it("pauses refund for a person, moves focus to the answer, and announces the outcome", async () => {
  const view = await mount(true)
  await view.pick("refund")
  expect(view.board()).toBe("refund")
  expect(view.states()).toEqual([
    "scope:passed",
    "permission:waiting",
    "sandbox:unreached",
    "delegation:unreached",
  ])
  expect(view.focused()).toBe("Allow once")
  expect(view.live()).toBe(say("refund"))

  await view.press('[data-decision="once"]')
  expect(view.board()).toBe("refund-once")
  expect(view.states()).toEqual([
    "scope:passed",
    "permission:passed",
    "sandbox:skipped",
    "delegation:skipped",
  ])
  expect(view.live()).toBe(say("refund-once"))
  expect(view.focused()).toBe("Ask again")
  // The radio still says refund: the decision is part of the same call.
  expect(view.radio("refund").checked).toBe(true)

  await view.press('[data-action="again"]')
  expect(view.board()).toBe("refund")
  expect(view.focused()).toBe("Allow once")
  await view.press('[data-decision="deny"]')
  expect(view.board()).toBe("refund-deny")
  expect(view.states()[1]).toBe("permission:stopped")
  expect(view.live()).toBe(say("refund-deny"))
  expect(view.focused()).toBe("Ask again")
})

it("pauses runBash too: allowed once it is contained by the sandbox, denied it never runs", async () => {
  const view = await mount(true)
  await view.pick("bash")
  expect(view.board()).toBe("bash")
  expect(view.states()).toEqual([
    "scope:passed",
    "permission:waiting",
    "sandbox:unreached",
    "delegation:unreached",
  ])
  expect(view.file()).toBe("config")
  expect(view.marked()).toEqual([
    'permissions: { mode: "interactive" },',
    'network: { mode: "deny" },',
  ])
  expect(view.focused()).toBe("Allow once")
  expect(view.live()).toBe(
    'runBash("curl … | sh"): Tool scope passed, Permission waiting for approval. The run pauses for approval. Allow it once, or deny it.',
  )

  await view.press('[data-decision="once"]')
  expect(view.board()).toBe("bash-once")
  expect(view.states()).toEqual([
    "scope:passed",
    "permission:passed",
    "sandbox:contained",
    "delegation:skipped",
  ])
  expect(view.live()).toBe(
    'runBash("curl … | sh"): Tool scope passed, Permission passed, Sandbox contained. The command runs inside the sandbox, where curl can\'t reach example.com, so the download fails.',
  )
  expect(view.focused()).toBe("Ask again")
  expect(view.radio("bash").checked).toBe(true)

  await view.press('[data-action="again"]')
  expect(view.board()).toBe("bash")
  expect(view.focused()).toBe("Allow once")
  await view.press('[data-decision="deny"]')
  expect(view.board()).toBe("bash-deny")
  expect(view.states()).toEqual([
    "scope:passed",
    "permission:stopped",
    "sandbox:unreached",
    "delegation:unreached",
  ])
  expect(view.live()).toBe(say("bash-deny"))
  expect(view.focused()).toBe("Ask again")
})

it("leaves focus in the radio group when the visitor arrows onto a call that pauses", async () => {
  const view = await mount(true)
  view.radio("read").focus()
  await view.arrowTo("refund")
  expect(view.board()).toBe("refund")
  expect(view.live()).toBe(say("refund"))
  expect(document.activeElement).toBe(view.radio("refund"))
  await view.arrowTo("bash")
  expect(view.board()).toBe("bash")
  expect(view.live()).toBe(say("bash"))
  expect(document.activeElement).toBe(view.radio("bash"))
})

it("keeps focus in the tracer when a click that doesn't focus the radio hides the focused control", async () => {
  // Safari and Firefox on macOS don't focus a radio when its label is clicked,
  // so focus stays on whatever the visitor last used, which is about to go inert.
  const view = await mount(true)
  await view.pick("refund")
  expect(view.focused()).toBe("Allow once")
  await view.pick("read")
  expect(view.board()).toBe("read")
  expect(document.activeElement).toBe(view.radio("read"))

  await view.pick("bash")
  await view.press('[data-decision="deny"]')
  expect(view.focused()).toBe("Ask again")
  await view.pick("delete")
  expect(document.activeElement).toBe(view.radio("delete"))

  // The caption's docs link belongs to the call being replaced, too.
  const link = view.container.querySelector<HTMLAnchorElement>(
    '[data-scenario][data-active="true"] a',
  )
  link?.focus()
  expect(document.activeElement).toBe(link)
  await view.pick("delegate")
  expect(document.activeElement).toBe(view.radio("delegate"))
})

it("with motion on, a quick pick or answer kills the running trace and the state is already final", async () => {
  const view = await mount(false)
  const timeline = vi.spyOn(gsap, "timeline")
  // What each trace animates, read from the timelines the island created (a
  // killed timeline keeps its children). Assert the trace started, not that it
  // is still running: a slow act() flush under load can outlast its 180ms steps.
  const traced = () =>
    timeline.mock.results.map((result) =>
      (result.value as ReturnType<typeof gsap.timeline>)
        .getChildren(true, true, false)
        .flatMap((tween) => tween.targets() as Element[])
        .map((node) => node.closest("[data-board]")?.getAttribute("data-board")),
    )
  const traceOf = (id: string) => Array<string>(5).fill(id)
  await view.pick("bash")
  expect(traced()).toEqual([traceOf("bash")])
  // Answer before the pause has finished tracing.
  await view.press('[data-decision="once"]')
  expect(view.board()).toBe("bash-once")
  expect(view.live()).toBe(say("bash-once"))
  await view.pick("delegate")
  await view.pick("delete")
  // Final semantic state straight away, from one announcement per action.
  expect(view.board()).toBe("delete")
  expect(view.live()).toBe(say("delete"))
  // One trace per action, each over its own board's four gates and result.
  expect(traced()).toEqual(["bash", "bash-once", "delegate", "delete"].map(traceOf))
  // The killed traces are gone and left no inline styles.
  for (const id of ["bash", "bash-once", "delegate"]) {
    const gates = [...view.container.querySelectorAll(`[data-board="${id}"] [data-gate]`)]
    expect(
      gates.flatMap((node) => gsap.getTweensOf(node)),
      id,
    ).toEqual([])
    expect(
      gates.every((node) => (node as HTMLElement).style.opacity === ""),
      id,
    ).toBe(true)
  }
})
