// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test } from "vitest"
import type { PublicItem } from "../../../lib/turn-inspector/capture-types"
import { ActivityDetails } from "./ActivityDetails"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const item: PublicItem = {
  id: "tool-1",
  turnId: "turn-1",
  role: "tool",
  type: "toolCall",
  name: "readDoc",
  state: "complete",
  provenance: "live",
  content: { available: false },
  input: { available: true, value: { path: "aircraft/c172n.md" } },
  result: { available: true, value: '{"content":"<script>no()</script>","nested":{"count":2}}' },
}
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
async function render(value: PublicItem) {
  if (!root) {
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => root.render(<ActivityDetails item={value} />))
}
async function click(name: string) {
  const b = [...host.querySelectorAll("button")].find((b) => b.textContent === name)
  expect(b).toBeTruthy()
  await act(async () => b?.click())
}
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined as never
})
test("uses a single result viewport with an explicitly derived tree and original JSON", async () => {
  await render(item)
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Result")
  expect(host.textContent).toContain("Parsed from the recorded JSON string")
  expect(host.querySelector("script")).toBeNull()
  await click("JSON")
  expect(host.querySelector("pre")?.textContent).toBe(
    JSON.stringify(item.result.available ? item.result.value : null, null, 2),
  )
  await click("Arguments")
  expect(host.textContent).toContain("aircraft/c172n.md")
  expect(host.textContent).not.toContain("no()")
  await click("Event")
  expect(host.textContent).toContain("Normalized observed item")
})
test("selection changes reset the mode and missing results remain unavailable", async () => {
  await render(item)
  await click("Arguments")
  await render({ ...item, id: "tool-2", result: { available: false } })
  expect(host.textContent).toContain("Not available in this recording")
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Result")
})

test("large trees disclose only fifty entries at a time", async () => {
  await render({
    ...item,
    result: { available: true, value: Array.from({ length: 120 }, (_, i) => `entry-${i}`) },
  })
  expect(host.textContent).toContain("entry-49")
  expect(host.textContent).not.toContain("entry-50")
  await click("Show next 50 entries")
  expect(host.textContent).toContain("entry-99")
  expect(host.textContent).not.toContain("entry-100")
})
