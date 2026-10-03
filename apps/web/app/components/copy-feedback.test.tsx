// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { writeClipboard } from "./copy-feedback"
import { CopyCommand } from "./ui/CopyCommand"

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount())
  roots.length = 0
  document.body.innerHTML = ""
})

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
}

describe("copy feedback", () => {
  it("reports failure instead of throwing", async () => {
    clipboard(async () => {
      throw new Error("denied")
    })
    await expect(writeClipboard("x")).resolves.toBe(false)
    await expect(writeClipboard(Promise.reject(new Error("offline")))).resolves.toBe(false)
  })

  it("makes the whole install pill the copy button and announces the result", async () => {
    const writeText = vi.fn(async () => {})
    clipboard(writeText)
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<CopyCommand command="npm create b4-app@latest my-agent" />))
    const buttons = container.querySelectorAll("button")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toContain("npm create b4-app@latest my-agent")
    const statusEl = container.querySelector('[role="status"]')
    expect(statusEl?.textContent).toBe("")
    await act(async () => buttons[0]?.click())
    expect(writeText).toHaveBeenCalledWith("npm create b4-app@latest my-agent")
    expect(statusEl?.textContent).toBe("Copied")

    clipboard(async () => {
      throw new Error("denied")
    })
    await act(async () => buttons[0]?.click())
    expect(statusEl?.textContent).toBe("Copy failed")
  })
})
