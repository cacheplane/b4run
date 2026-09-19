import { describe, expect, it, vi } from "vitest"

import {
  runWorkbenchBrowserJourney,
  type WorkbenchBrowserDeps,
  type WorkbenchBrowserJourney,
} from "./workbench-browser.ts"

const PROMPT = "What are common agent architectures?"
const ANSWER = "ReAct and plan-and-execute are common. [corpus/agent-architectures.md]"

function fakeDeps(
  overrides: {
    readonly threadId?: string | undefined
    readonly consoleErrors?: readonly string[]
    readonly pageErrors?: readonly string[]
    readonly failRestore?: boolean
  } = {},
) {
  const calls: string[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  const page = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
    }),
    evaluate: vi.fn(async () => overrides.threadId),
    screenshot: vi.fn(async () => {
      calls.push("screenshot")
    }),
    getByRole: vi.fn(() => ({
      click: vi.fn(async () => {
        calls.push("click:Send")
      }),
    })),
  }
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {
      calls.push("context.close")
    }),
  }
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {
      calls.push("browser.close")
    }),
  }
  const chromium = { launch: vi.fn(async () => browser) }
  const journey: WorkbenchBrowserJourney = {
    openReadyWorkbench: vi.fn(async () => {
      calls.push("open")
      // Emit the errors after the page is open, like a real page would.
      for (const text of overrides.consoleErrors ?? []) {
        listeners.get("console")?.({
          type: () => "error",
          text: () => text,
          location: () => ({ url: "" }),
        })
      }
      for (const message of overrides.pageErrors ?? []) {
        listeners.get("pageerror")?.(new Error(message))
      }
    }),
    fillActiveWorkbenchComposer: vi.fn(async () => {
      calls.push("fill")
    }),
    waitForWorkbenchRunCompletion: vi.fn(async () => {
      calls.push("complete")
    }),
    restoreWorkbenchThread: vi.fn(async () => {
      calls.push("restore")
      if (overrides.failRestore) throw new Error("thread rail did not list the prompt")
    }),
  }
  const deps: WorkbenchBrowserDeps = { chromium: chromium as never, journey }
  return { calls, deps, page, chromium }
}

const baseOptions = {
  webUrl: "http://127.0.0.1:4712",
  prompt: PROMPT,
  tools: ["searchCorpus", "readDoc"],
  answer: ANSWER,
  screenshotPath: "/tmp/never-written.png",
}

describe("runWorkbenchBrowserJourney", () => {
  it("drives open → fill → send → complete → restore, then closes context and browser", async () => {
    const { calls, deps, chromium } = fakeDeps({ threadId: "t-1" })
    const result = await runWorkbenchBrowserJourney(baseOptions, deps)
    expect(calls).toEqual([
      "open",
      "fill",
      "click:Send",
      "complete",
      "restore",
      "context.close",
      "browser.close",
    ])
    expect(result).toEqual({ threadId: "t-1" })
    expect(chromium.launch).toHaveBeenCalledWith({ headless: true })
  })

  it("fails when the Workbench never persists the thread id, and still closes the browser", async () => {
    const { calls, deps, page } = fakeDeps({ threadId: undefined })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).rejects.toThrow(
      /did not persist the active thread id/,
    )
    expect(page.screenshot).toHaveBeenCalledWith({
      path: baseOptions.screenshotPath,
      fullPage: true,
    })
    expect(calls.slice(-2)).toEqual(["context.close", "browser.close"])
  })

  it("fails on a console error even when every step succeeded", async () => {
    const { deps } = fakeDeps({ threadId: "t-1", consoleErrors: ["Hydration failed"] })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).rejects.toThrow(
      /console errors.*Hydration failed/s,
    )
  })

  it("fails on an uncaught page error", async () => {
    const { deps } = fakeDeps({ threadId: "t-1", pageErrors: ["boom"] })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).rejects.toThrow(/pageerror: boom/)
  })

  it("screenshots and rethrows when restoration fails", async () => {
    const { deps, page } = fakeDeps({ threadId: "t-1", failRestore: true })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).rejects.toThrow(
      /thread rail did not list the prompt/,
    )
    expect(page.screenshot).toHaveBeenCalledTimes(1)
  })
})
