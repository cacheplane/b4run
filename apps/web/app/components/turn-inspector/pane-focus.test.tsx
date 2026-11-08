// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, expect, test } from "vitest"
import { parseCapture } from "../../../lib/turn-inspector/capture-schema"
import fixture from "./__fixtures__/synthetic-capture.json"
import { TurnInspector } from "./TurnInspector"

beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }))
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
let style: HTMLStyleElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  style?.remove()
  style = undefined
})
test.each([true, false])(
  "activity focus follows the revealed pane only when narrow=%s",
  async (narrow) => {
    // jsdom does not evaluate container queries; apply the narrow rule explicitly.
    if (narrow) {
      style = document.createElement("style")
      style.textContent = '[data-visible="false"] { display: none; }'
      document.head.append(style)
    }
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <TurnInspector
          capture={parseCapture(JSON.stringify(fixture))}
          moment={{ id: "message", request: 1 }}
        />,
      ),
    )
    const item = host.querySelector<HTMLButtonElement>('button[data-item-id="message-1"]')
    expect(item).toBeTruthy()
    item?.focus()
    await act(async () => item?.click())
    const details = host.querySelector('aside[aria-label="Activity details"]')
    if (narrow) expect(details?.contains(document.activeElement)).toBe(true)
    else expect(document.activeElement).toBe(item)
  },
)
