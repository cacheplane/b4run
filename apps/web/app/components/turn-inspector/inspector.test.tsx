// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test } from "vitest"
import { parseCapture } from "../../../lib/turn-inspector/capture-schema"
import fixture from "./__fixtures__/synthetic-capture.json"
import { TurnInspector } from "./TurnInspector"

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
async function mount() {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(<TurnInspector capture={parseCapture(JSON.stringify(fixture))} />),
  )
}
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === label,
  )
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}
test("steps backward without exposing future results and keeps approval read-only", async () => {
  await mount()
  await click("Next event")
  await click("Next event")
  expect(host.textContent).toContain("Hello world")
  await click("Previous event")
  expect(host.textContent).not.toContain("Hello world")
  await click("Next event")
  await click("Next event")
  expect(host.textContent).toContain("File the plan?")
  expect(host.querySelector("button[data-approve]")).toBeNull()
  await click("Next event")
  expect(host.textContent).toContain("Decision not available in this recording")
})
test("selects repeated tool names by stable IDs and labels missing values", async () => {
  await mount()
  for (let i = 0; i < 5; i++) await click("Next event")
  const tools = host.querySelectorAll<HTMLButtonElement>('button[data-item-id^="tool-"]')
  expect(tools).toHaveLength(2)
  await act(async () => tools[1]!.click())
  expect(host.querySelector('[data-details-id="tool-2"]')).not.toBeNull()
  expect(host.textContent).toContain("Not available in this recording")
})

test("bottom player moment selects the recorded item and supports keyboard transport names", async () => {
  await mount()
  const player = host.querySelector("[data-player]")
  const details = host.querySelector('aside[aria-label="Activity details"]')
  expect(details?.compareDocumentPosition(player!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  await click("Inspect Completed message")
  expect(host.querySelector('[data-details-id="message-1"]')).not.toBeNull()
  expect(host.querySelector('input[type="range"]')?.getAttribute("value")).toBe("2")
  await click("Playback speed 1×")
  expect(host.querySelector('button[aria-label="Playback speed 2×"]')).not.toBeNull()
})
