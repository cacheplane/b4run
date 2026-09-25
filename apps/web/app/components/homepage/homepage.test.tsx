// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { CodePanel } from "./CodePanel"
import { DeveloperHome } from "./DeveloperHome"
import { ScaffoldTerminal } from "./ScaffoldTerminal"
import { prepareTourCode } from "./tour/tour-sources"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

it("opens with the install command, then the folder tour, the guardrails and the route shapes", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const hero = container.querySelector('[aria-labelledby="home-title"]')
  expect(hero?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(hero?.querySelector('a[href="/docs/getting-started"]')?.textContent).toBe("Get started →")
  const first = container.querySelector("#first-agent")
  expect(first?.textContent).toContain("src/app/hello/index.ts")
  expect(first?.textContent).toContain("src/app/hello/tools/greet.ts")
  expect(container.querySelector("#guardrails h2")?.textContent).toBe(
    "Four checks decide what a call can do.",
  )
  expect(container.querySelector("#route-shapes h2")?.textContent).toBe("Pick the shape per route.")
  const order = ["home-title", "first-agent", "guardrails", "route-shapes", "run-title"].map((id) =>
    [...container.querySelectorAll("[id]")].findIndex((node) => node.id === id),
  )
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
})

it("shows the runtime and what the command creates beside the headline", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const hero = container.querySelector('[aria-labelledby="home-title"]')
  expect(hero?.textContent).toContain("Runs on LangGraph.js. You keep the graph.")
  const figure = hero?.querySelector("figure")
  expect(figure?.querySelector("figcaption")?.textContent).toBe("What npm create b4-app scaffolds")
  // The tree's agent row points at the section that opens those files.
  expect(figure?.querySelector('a[href="#first-agent"]')).not.toBeNull()
  expect(container.querySelector("#first-agent")).not.toBeNull()
  // The old dot hung directly off the hero; the eclipse now sits beside the
  // terminal, as an empty decorative element outside the figure.
  expect(hero?.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(0)
  const decorations = [...(hero?.querySelectorAll('[aria-hidden="true"]:empty') ?? [])]
  expect(decorations.filter((node) => !node.closest("figure"))).toHaveLength(1)
})

it("marks only off-site links with ↗ and opens them in a new tab", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  for (const link of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href") ?? ""
    if (href.startsWith("http")) {
      expect(link.getAttribute("target"), href).toBe("_blank")
      expect(link.getAttribute("rel"), href).toContain("noopener")
    } else {
      expect(link.textContent, href).not.toContain("↗")
    }
    expect(href).not.toContain("docs/superpowers")
  }
  expect(container.querySelector("details")).toBeNull()
})

it("ends with the install command, and the code-fixer walkthrough is gone", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const takeaway = container.querySelector('[aria-labelledby="run-title"]')
  expect(takeaway?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(takeaway?.querySelector('a[href="/docs/getting-started"]')).not.toBeNull()
  expect(takeaway?.children).toHaveLength(1)
  expect(container.textContent).not.toMatch(/code-fixer|code fixer|b4 add/i)
  expect(container.querySelector('a[href*="examples/code-fixer"]')).toBeNull()
  expect(container.textContent).not.toContain("—")
})

it("names every labelled region uniquely", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const labels = [...container.querySelectorAll("section[aria-label]")].map((node) =>
    node.getAttribute("aria-label"),
  )
  expect(labels).toContain("src/app/hello/index.ts")
  expect(labels).toContain("What the model sees")
  expect(new Set(labels).size).toBe(labels.length)
})

it("renders source markup as inert text", async () => {
  const { highlightCode } = await import("./highlight")
  const code = await highlightCode(
    '<script>alert("inert")</script>',
    "typescript",
    "example.ts",
    "https://example.com/source",
  )
  const html = renderToString(<CodePanel code={code} />)
  expect(html).not.toContain('<script>alert("inert")</script>')
  expect(html).toContain("&lt;")
  // Token colours are classes from app/styles/syntax.css, not inline styles.
  expect(html).toContain('class="sh')
  expect(html).not.toContain("style=")
})

it("renders and copies a tour file whole, with visual wrapping only", async () => {
  const { eval: smoke } = await prepareTourCode()
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  await act(async () => root?.render(<CodePanel code={smoke} />))
  const rendered = [...container.querySelectorAll("pre code > span")]
    .map((line) => (line.lastElementChild?.textContent ?? "").trimEnd())
    .join("\n")
  expect(rendered.trimEnd()).toBe(smoke.raw.trimEnd())
  expect(container.querySelector("[aria-expanded]")).toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click())
  expect(writeText).toHaveBeenCalledWith(smoke.raw)
})

it("renders the scaffold as a captioned figure a screen reader can follow", () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<ScaffoldTerminal />)
  const figure = container.querySelector("figure")
  expect(figure?.querySelector("figcaption")?.textContent).toBe("What npm create b4-app scaffolds")
  expect(figure?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(figure?.textContent).toContain("Created my-agent (basic template)")
  expect(figure?.textContent).toContain("cd my-agent && npm install && npm test")
  expect(figure?.querySelector("ul")?.children).toHaveLength(4)
  expect(figure?.querySelectorAll("ul ul > li")).toHaveLength(3)
  // Glyphs, prompts, the marker and the arrow are decoration: with every
  // aria-hidden node removed, what remains reads as plain labels and notes.
  const spoken = figure?.cloneNode(true) as HTMLElement
  for (const hidden of spoken.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  const text = spoken.textContent ?? ""
  expect(text).not.toMatch(/[│├└─✔↓$]/)
  expect(text).toContain("src/app/hello/, the agent")
  expect(text).toContain("npm create b4-app@latest my-agent")
  const agent = figure?.querySelector<HTMLAnchorElement>('a[href="#first-agent"]')
  expect(agent?.textContent?.replace(/\s+/g, " ")).toContain("src/app/hello/")
  expect(agent?.textContent).toContain("the agent")
  // Every row's --i is unique, so no two lines appear at once.
  // Read the attribute: jsdom's CSSStyleDeclaration is unreliable for custom properties.
  const orders = [...(figure?.querySelectorAll("[style*='--i']") ?? [])].map(
    (node) => node.getAttribute("style")?.match(/--i:\s*(\d+)/)?.[1],
  )
  expect(new Set(orders).size).toBe(orders.length)
  expect(orders).toHaveLength(10)
})

it("marks the first-agent section with the dot the terminal's agent row carries", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const eyebrow = container.querySelector('#first-agent [data-ui="eyebrow"]')
  expect(eyebrow?.textContent).toBe("Your first agent")
  expect(eyebrow?.querySelector('span[aria-hidden="true"]')).not.toBeNull()
})
