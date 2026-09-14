// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { Capabilities } from "./Capabilities"
import { CodePanel } from "./CodePanel"
import { prepareHomepage } from "./highlight"
import { Walkthrough } from "./Walkthrough"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})
const prepared = await prepareHomepage()

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
  await act(async () =>
    root?.render(
      <>
        <Walkthrough {...prepared.walkthrough} />
        <Capabilities items={prepared.capabilities} />
      </>,
    ),
  )
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
  await click("Evals")
  expect(container.textContent).toContain("gate.perScorer")
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
