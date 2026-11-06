// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { parseCapture } from "../../../lib/turn-inspector/capture-schema"
import type { LessonSource } from "../../../lib/turn-inspector/lesson-types"
import fixture from "./__fixtures__/synthetic-capture.json"
import { TurnInspector } from "./TurnInspector"

vi.mock("../../../lib/turn-inspector/load-capture", () => ({
  readVerifiedAsset: async () => "first\nsecond\n",
}))
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})
const sources: LessonSource[] = [
  {
    path: "examples/navlog/example.ts",
    revision: "a".repeat(40),
    digest: "a".repeat(64),
    language: "typescript",
    ranges: [{ start: 2, end: 2, moment: "message" }],
  },
]
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
const openHref = `/docs/app/inspect/${fixture.id}`
async function mount() {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <TurnInspector
        capture={parseCapture(JSON.stringify(fixture))}
        sources={sources}
        openHref={openHref}
      />,
    ),
  )
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === label,
  )
  expect(button).toBeTruthy()
  await act(async () => button?.click())
}
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  window.history.replaceState(null, "", "/")
})
test("player moment selects the corresponding source range", async () => {
  await mount()
  await click("Inspect Completed message")
  await click("Source")
  expect(host.querySelector('[data-highlighted="true"]')?.textContent).toContain("second")
})
test("opening the inspector preserves the player-selected moment", async () => {
  await mount()
  await click("Inspect Completed message")
  expect(host.querySelector("a")?.getAttribute("href")).toBe(
    `${openHref}#inspect/${fixture.id}/message`,
  )
})
