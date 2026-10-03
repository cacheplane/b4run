// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Composer, type ComposerMessage } from "./Composer"

const noop = () => {}

function render(
  state: { isRunning: boolean; isAwaitingApproval: boolean },
  canAttachImages = false,
): string {
  return renderToStaticMarkup(
    <Composer onSend={noop} onStop={noop} canAttachImages={canAttachImages} {...state} />,
  )
}

const IDLE = { isRunning: false, isAwaitingApproval: false }
const RUNNING = { isRunning: true, isAwaitingApproval: false }
const AWAITING = { isRunning: false, isAwaitingApproval: true }

describe("composer", () => {
  test("cannot send an empty message even when nothing is blocking", () => {
    expect(render(IDLE)).toContain("disabled")
  })

  test("keeps the blocked textarea focusable and described, not disabled", () => {
    // `disabled` on the textarea would yank focus out of the box mid-sentence
    // when an interrupt arrives, and hide it from assistive tech entirely.
    const markup = render(AWAITING)
    expect(markup).toMatch(/\breadonly=""/i)
    expect(markup).toContain('aria-disabled="true"')
    expect(markup).toMatch(/aria-describedby="[^"]+"/)
  })

  test("offers Stop instead of Send while a run is in flight", () => {
    // Without it, the only escape from a long — or hung, where `isRunning`
    // never clears — run is switching threads, which destroys the transcript.
    const markup = render(RUNNING)
    expect(markup).toContain("Stop")
    expect(markup).not.toContain("Send")
  })

  /**
   * The one that matters: a parked permission gate is NOT `isRunning`. The run
   * has finished — with an interrupt — so gating on `isRunning` alone leaves
   * the composer live, and sending from there throws inside `runAgent` after
   * the user's message is already in the transcript.
   */
  test("blocks sending while an approval is outstanding, and says why", () => {
    const markup = render(AWAITING)
    expect(markup).toContain("disabled")
    expect(markup).toContain("Allow or deny the request above to continue this conversation.")
    expect(markup).toContain("Waiting on your decision above…")
  })

  test("explains a blocked composer instead of only greying it out", () => {
    // Each blocked state has its own reason; neither reuses the idle hint.
    const idleHint = "Enter to send · Shift+Enter for a new line"
    expect(render(IDLE)).toContain(idleHint)
    expect(render(AWAITING)).not.toContain(idleHint)
    expect(render(RUNNING)).toContain("The agent is working…")
  })
})

describe("composer attachments", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function mount(onSend: (message: ComposerMessage) => void) {
    act(() => {
      root.render(
        <Composer
          onSend={onSend}
          onStop={noop}
          isRunning={false}
          isAwaitingApproval={false}
          canAttachImages
        />,
      )
    })
  }

  function button(name: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent === name || candidate.getAttribute("aria-label") === name,
    )
    if (found === undefined) throw new Error(`no button "${name}"`)
    return found
  }

  /** What picking files in the OS dialog looks like to the page. */
  async function pick(...files: File[]) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error("no file input")
    Object.defineProperty(input, "files", { configurable: true, value: files })
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }))
    })
    // jsdom's FileReader finishes on a later task, not a microtask.
    await vi.waitFor(() => {
      expect(container.querySelectorAll("[data-attachment]")).toHaveLength(files.length)
    })
  }

  const png = () => new File([new Uint8Array([1, 2, 3])], "chart.png", { type: "image/png" })

  test("offers no attach control when the route does not take images", () => {
    expect(render({ isRunning: false, isAwaitingApproval: false }, false)).not.toContain(
      "Attach image",
    )
  })

  test("offers an image-only file picker behind an Attach image button when it does", () => {
    const markup = render({ isRunning: false, isAwaitingApproval: false }, true)
    expect(markup).toContain("Attach image")
    expect(markup).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*multiple=""/)
  })

  test("a pending attachment enables Send with no text, and sends the image as a data part", async () => {
    const onSend = vi.fn<(message: ComposerMessage) => void>()
    mount(onSend)
    expect(button("Send").disabled).toBe(true)
    await pick(png())
    expect(container.textContent).toContain("chart.png")
    expect(button("Send").disabled).toBe(false)
    act(() => {
      button("Send").click()
    })
    expect(onSend).toHaveBeenCalledWith({
      text: "",
      parts: [
        {
          type: "image",
          source: { type: "data", value: "AQID", mimeType: "image/png" },
          metadata: { filename: "chart.png" },
        },
      ],
    })
    // Sending clears the attachments with the text.
    expect(container.querySelectorAll("[data-attachment]")).toHaveLength(0)
  })

  test("text and attachments travel together", async () => {
    const onSend = vi.fn<(message: ComposerMessage) => void>()
    mount(onSend)
    const textarea = container.querySelector("textarea")
    if (textarea === null) throw new Error("no textarea")
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      setter?.call(textarea, "  what does this show?  ")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await pick(png())
    act(() => {
      button("Send").click()
    })
    expect(onSend.mock.calls[0]?.[0].text).toBe("what does this show?")
    expect(onSend.mock.calls[0]?.[0].parts).toHaveLength(1)
  })

  test("a removed attachment is not sent", async () => {
    const onSend = vi.fn<(message: ComposerMessage) => void>()
    mount(onSend)
    await pick(png())
    act(() => {
      button("Remove chart.png").click()
    })
    expect(container.querySelectorAll("[data-attachment]")).toHaveLength(0)
    expect(button("Send").disabled).toBe(true)
  })

  test("a text-only send carries no parts", () => {
    const onSend = vi.fn<(message: ComposerMessage) => void>()
    mount(onSend)
    const textarea = container.querySelector("textarea")
    if (textarea === null) throw new Error("no textarea")
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      setter?.call(textarea, "hello")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => {
      button("Send").click()
    })
    expect(onSend).toHaveBeenCalledWith({ text: "hello", parts: [] })
  })

  test("a non-image file is ignored, with a hint saying why", async () => {
    mount(vi.fn())
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error("no file input")
    const exe = new File([new Uint8Array([77, 90])], "setup.exe", {
      type: "application/x-msdownload",
    })
    Object.defineProperty(input, "files", { configurable: true, value: [exe, exe] })
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(container.querySelectorAll("[data-attachment]")).toHaveLength(0)
    expect(container.textContent).toContain("Only images can be attached")
    expect(container.textContent?.split("Only images can be attached")).toHaveLength(2)
    expect(button("Send").disabled).toBe(true)
  })

  describe("with a FileReader the test drives", () => {
    const readers: ControlledReader[] = []

    class ControlledReader {
      result: string | null = null
      error: Error | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL() {
        readers.push(this)
      }
      succeed(url: string) {
        this.result = url
        this.onload?.()
      }
      fail() {
        this.error = new Error("boom")
        this.onerror?.()
      }
    }

    beforeEach(() => {
      readers.length = 0
      vi.stubGlobal("FileReader", ControlledReader)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    async function choose(file: File) {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')
      if (input === null) throw new Error("no file input")
      Object.defineProperty(input, "files", { configurable: true, value: [file] })
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }))
      })
    }

    test("Send is disabled while a read is pending, and enabled once it lands", async () => {
      mount(vi.fn())
      const textarea = container.querySelector("textarea")
      if (textarea === null) throw new Error("no textarea")
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
        setter?.call(textarea, "with words already")
        textarea.dispatchEvent(new Event("input", { bubbles: true }))
      })
      expect(button("Send").disabled).toBe(false)
      await choose(png())
      expect(readers).toHaveLength(1)
      expect(button("Send").disabled).toBe(true)
      await act(async () => {
        readers[0]?.succeed("data:image/png;base64,AQID")
      })
      expect(container.querySelectorAll("[data-attachment]")).toHaveLength(1)
      expect(button("Send").disabled).toBe(false)
    })

    test("a read error says which file could not be read", async () => {
      mount(vi.fn())
      await choose(png())
      await act(async () => {
        readers[0]?.fail()
      })
      expect(container.textContent).toContain("Could not read chart.png")
      expect(container.querySelectorAll("[data-attachment]")).toHaveLength(0)
      expect(button("Send").disabled).toBe(true)
    })
  })
})
