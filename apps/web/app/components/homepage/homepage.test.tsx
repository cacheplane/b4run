// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { CodePanel } from "./CodePanel"
import { DeveloperHome } from "./DeveloperHome"
import { prepareHomepage } from "./highlight"
import { exampleUrl, narrativeSource, prepareNarrative } from "./narrative-source"
import { ScaffoldTerminal } from "./ScaffoldTerminal"
import { Walkthrough } from "./Walkthrough"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})
const prepared = await prepareHomepage()

it("opens with the install command and a first agent from the basic template", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const hero = container.querySelector('[aria-labelledby="home-title"]')
  expect(hero?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(hero?.querySelector('a[href="/docs/getting-started"]')?.textContent).toBe("Get started →")
  const first = container.querySelector("#first-agent")
  expect(first?.textContent).toContain("src/app/hello/index.ts")
  expect(first?.textContent).toContain("src/app/hello/tools/greet.ts")
  const order = ["first-agent", "blueprint", "project", "run-title"].map((id) =>
    [...container.querySelectorAll("[id]")].findIndex((node) => node.id === id),
  )
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

it("marks only off-site links with ↗, opens them in a new tab, and pins example links", async () => {
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
    if (href.includes("examples/code-fixer")) expect(href).toContain(narrativeSource.sourceCommit)
  }
  expect(container.querySelector(`a[href="${exampleUrl}"]`)).not.toBeNull()
  expect(container.querySelector("details")).toBeNull()
})

it("ends with the install command and the code-fixer guide", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  expect(container.textContent).toContain("Agent source")
  const takeaway = container.querySelector('[aria-labelledby="run-title"]')
  expect(takeaway?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(takeaway?.querySelector('a[href="/docs/getting-started"]')).not.toBeNull()
  expect(takeaway?.textContent).toContain("b4 add code-fixer")
  expect(container.textContent).not.toMatch(/Qualified|0\.8\.32|Historical defect|earlier versions/)
  expect(container.textContent).not.toContain("run:agent")
  expect(container.textContent).not.toContain("—")
  expect(container.querySelector('a[href="/blueprints/code-fixer.md"]')).toBeNull()
  expect(container.querySelector('a[href="/docs/cli#b4-add"]')).not.toBeNull()
  expect(container.textContent).toContain("fix/tools/prepareReview.ts")
  const narrative = container.querySelector('[data-narrative="current-example"]')
  if (!narrative) throw new Error("Narrative is missing")
  expect(narrative.textContent).not.toContain("6m 14s")
  expect([...narrative.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
    "This project is the whole agent.",
    "This code runs this agent.",
    "Give it somewhere to work.",
    "Your functions become its tools.",
    "Give it a working method.",
    "Define what “done” means.",
    "The next action is your call.",
    "One request runs the whole workflow.",
  ])
  const tool = narrative.querySelector("#tools pre code")
  expect(tool?.textContent).toContain("await inspectCandidate(ctx)")
  expect(tool?.textContent).toContain("await verifyChanges(")
  expect(tool?.textContent).toContain("renderReviewDiff(baseline, candidate.changes)")
  expect(narrative.querySelector("#tools [aria-expanded]")).toBeNull()
  expect(container.textContent).toContain("6m 14s")
  expect(container.textContent).toContain("Awaiting your approval")
})

it("names every labelled region uniquely", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const labels = [...container.querySelectorAll("section[aria-label]")].map((node) =>
    node.getAttribute("aria-label"),
  )
  expect(labels).toContain("Recorded run · index.ts")
  expect(new Set(labels).size).toBe(labels.length)
})

it("server renders actual source, checks, and pending approval", () => {
  const html = renderToString(<Walkthrough {...prepared.walkthrough} />)
  expect(html).toContain("@b4run/sdk")
  expect(html).toContain("1 / 1 passed")
  expect(html).toContain("3 / 3 passed")
  for (const name of [...prepared.walkthrough.visible, ...prepared.walkthrough.independent])
    expect(html).toContain(name)
  expect(prepared.walkthrough.patch.url).toContain("/app/components/homepage/evidence.json")
  for (const file of Object.values(prepared.walkthrough.files)) {
    expect(file.url).toBe(
      `https://github.com/cacheplane/b4run/blob/${narrativeSource.sourceCommit}/examples/code-fixer/server/${file.path}`,
    )
    expect(file.path).not.toContain("recorded")
  }
  expect(html).toContain('aria-label="Recorded run · index.ts"')
  expect(html).toContain("Awaiting your approval")
  expect(html).not.toContain("Patch exported")
})

it("switches steps and files independently and keeps full source copyable", async () => {
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(<Walkthrough {...prepared.walkthrough} />))
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(label),
    )
    expect(button).toBeDefined()
    await act(async () => button?.click())
  }
  await click("Reproduce")
  expect(container.textContent).toContain("unknown option '--dry-run'")
  await click("b4.config.ts")
  await click("Repair")
  expect(container.querySelector('[data-source="config"]')).not.toBeNull()
  expect(container.querySelector('[data-step="repair"][aria-pressed="true"]')).not.toBeNull()
  await click("index.ts")
  await click("Show instructions")
  expect(container.textContent).toContain("Do not claim success")
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[data-source="agent"] button')]
      .find((b) => b.textContent === "Copy source")
      ?.click(),
  )
  expect(writeText).toHaveBeenCalledWith(prepared.walkthrough.files.agent.raw)
  writeText.mockRejectedValueOnce(new Error("Denied"))
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[data-source="agent"] button')]
      .find((b) => b.textContent === "Copy source")
      ?.click(),
  )
  expect(container.textContent).toContain("Copy unavailable")
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

it("renders and copies the complete review tool with visual wrapping only", async () => {
  const { tool } = await prepareNarrative()
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  await act(async () => root?.render(<CodePanel code={tool} />))
  const rendered = [...container.querySelectorAll("pre code > span")]
    .map((line) => (line.lastElementChild?.textContent ?? "").trimEnd())
    .join("\n")
  expect(rendered.trimEnd()).toBe(tool.raw.trimEnd())
  expect(container.querySelector("[aria-expanded]")).toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click())
  expect(writeText).toHaveBeenCalledWith(tool.raw)
})

it("connects the project map to code sections and ends with the execution flow", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const links = [...container.querySelectorAll('nav[aria-label="Explore project files"] a')]
  expect(links).toHaveLength(10)
  for (const link of links) {
    const target = link.getAttribute("href")
    expect(target?.startsWith("#")).toBe(true)
    expect(container.querySelector(target ?? "missing")).not.toBeNull()
  }
  const execution = container.querySelector('[aria-labelledby="execution-title"]')
  expect(
    [...(execution?.querySelectorAll("li strong") ?? [])].map((item) => item.textContent),
  ).toEqual(["Request", "Repair", "Verify", "Pause", "Approve", "Export"])
  expect(container.querySelector('nav[aria-label="Follow the example"]')).toBeNull()
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
