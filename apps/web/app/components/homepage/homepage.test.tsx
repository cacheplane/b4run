// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { CodePanel } from "./CodePanel"
import { DeveloperHome } from "./DeveloperHome"
import { sourceUrl } from "./evidence"
import { prepareHomepage } from "./highlight"
import { prepareNarrative } from "./narrative-source"
import { Walkthrough } from "./Walkthrough"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})
const prepared = await prepareHomepage()

it("ends with the install command and the code-fixer guide", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  expect(container.textContent).toContain("Agent source")
  expect(container.querySelector(`a[href="${sourceUrl("README.md")}"]`)).not.toBeNull()
  const takeaway = container.querySelector('[aria-labelledby="run-title"]')
  expect(takeaway?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(takeaway?.textContent).toContain("b4 add code-fixer")
  expect(container.textContent).not.toMatch(/Qualified|0\.8\.32|Historical defect|earlier versions/)
  expect(container.textContent).not.toContain("run:agent")
  expect(container.textContent).not.toContain("—")
  expect(container.querySelector('a[href="/blueprints/code-fixer.md"]')).toBeNull()
  expect(container.querySelector('a[href="/docs/cli#b4-add"]')).not.toBeNull()
  expect(container.textContent).toContain("fix/tools/prepareReview.ts")
  const narrative = container.querySelector('[data-narrative="current-example"]')
  if (!narrative) throw new Error("Narrative is missing")
  expect(narrative.textContent).not.toContain("1m 53s")
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
  expect(container.textContent).toContain("1m 53s")
  expect(container.textContent).toContain("Awaiting your approval")
})

it("server renders actual source, checks, and pending approval", () => {
  const html = renderToString(<Walkthrough {...prepared.walkthrough} />)
  expect(html).toContain("@b4run/sdk")
  expect(html).toContain("1 / 1 passed")
  expect(html).toContain("3 / 3 passed")
  for (const name of [...prepared.walkthrough.visible, ...prepared.walkthrough.independent])
    expect(html).toContain(name)
  expect(prepared.walkthrough.patch.url).toContain("/app/components/homepage/evidence.json")
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
