// @vitest-environment jsdom
import { act, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { parseCapture } from "../../../lib/turn-inspector/capture-schema"
import fixture from "./__fixtures__/synthetic-capture.json"
import { InspectMoment } from "./InspectMoment"
import { InspectorLoader } from "./InspectorLoader"
import { InspectorProvider } from "./inspector-context"

vi.mock("../../../lib/turn-inspector/lessons", () => ({
  getLesson: (id: string) =>
    id === fixture.id
      ? {
          id,
          title: "Fixture",
          digest: "a".repeat(64),
          revisions: fixture.revisions,
          lessonHref: "/docs/app",
          transcript: "/docs-recordings/test.md",
          moments: ["message"],
          sources: [],
        }
      : undefined,
}))
const load = vi.fn(async () => parseCapture(JSON.stringify(fixture)))
vi.mock("../../../lib/turn-inspector/load-capture", () => ({ readCaptureAsset: () => load() }))
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  load.mockClear()
  window.history.replaceState(null, "", "/")
})
test("a teaching moment loads once, seeks backward, and preserves a normal link", async () => {
  await import("./TurnInspector")
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <InspectorProvider>
        <InspectorLoader lesson={fixture.id} />
        <InspectMoment lesson={fixture.id} moment="message">
          Inspect the message
        </InspectMoment>
      </InspectorProvider>,
    ),
  )
  const link = host.querySelector<HTMLAnchorElement>('a[href*="#inspect"]')
  expect(link?.href).toContain(`/docs/app/inspect/${fixture.id}`)
  await act(async () => link?.click())
  expect(load).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain("Hello world")
  expect(window.location.hash).toContain("message")
  await act(async () => link?.click())
  expect(load).toHaveBeenCalledTimes(1)
  expect(host.textContent).not.toContain("turn-2")
})

test("a direct moment link recovers from Strict Mode's setup cancellation", async () => {
  await import("./TurnInspector")
  window.history.replaceState(null, "", `/#inspect/${fixture.id}/message`)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <StrictMode>
        <InspectorProvider>
          <InspectorLoader lesson={fixture.id} />
        </InspectorProvider>
      </StrictMode>,
    ),
  )
  expect(host.textContent).toContain("Hello world")
  expect(host.textContent).not.toContain("Loading recording")
})
