import type { Browser, BrowserContext, Page } from "@playwright/test"
import { describe, expect, it, vi } from "vitest"

import {
  findPersistedThreadId,
  runWorkbenchBrowserJourney,
  type WorkbenchBrowserDeps,
  type WorkbenchBrowserJourney,
} from "./workbench-browser.ts"

const PROMPT = "What are common agent architectures?"
const ANSWER = "ReAct and plan-and-execute are common. [corpus/agent-architectures.md]"
const STORAGE_KEY = "b4.workbench.threads"

function fakeDeps(
  overrides: {
    readonly threadId?: string | undefined
    readonly title?: string
    readonly consoleErrors?: readonly string[]
    readonly consoleWarnings?: readonly string[]
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
    evaluate: vi.fn(async () => {
      if (overrides.threadId === undefined) return null
      return JSON.stringify([{ id: overrides.threadId, title: overrides.title ?? PROMPT }])
    }),
    screenshot: vi.fn(async () => {
      calls.push("screenshot")
    }),
    getByRole: vi.fn(() => ({
      click: vi.fn(async () => {
        calls.push("click:Send")
      }),
    })),
  } as unknown as Page
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {
      calls.push("context.close")
    }),
  } as unknown as BrowserContext
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {
      calls.push("browser.close")
    }),
  } as unknown as Browser
  const chromium: WorkbenchBrowserDeps["chromium"] = { launch: vi.fn(async () => browser) }
  const journey: WorkbenchBrowserJourney = {
    openReadyWorkbench: vi.fn(async () => {
      calls.push("open")
      // Emit the errors/warnings after the page is open, like a real page would.
      for (const text of overrides.consoleErrors ?? []) {
        listeners.get("console")?.({
          type: () => "error",
          text: () => text,
          location: () => ({ url: "" }),
        })
      }
      for (const text of overrides.consoleWarnings ?? []) {
        listeners.get("console")?.({
          type: () => "warning",
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
      return { stateUrl: "http://127.0.0.1:4712/api/b4/threads/t-1/state" }
    }),
  }
  const deps: WorkbenchBrowserDeps = { chromium, journey }
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
    const { calls, deps, chromium, page } = fakeDeps({ threadId: "t-1" })
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
    expect(page.getByRole).toHaveBeenCalledWith("button", { name: "Send", exact: true })
    expect(page.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ key: STORAGE_KEY }),
    )
  })

  it("succeeds despite a console warning (only errors fail the gate)", async () => {
    const { deps } = fakeDeps({ threadId: "t-1", consoleWarnings: ["deprecated API"] })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).resolves.toEqual({
      threadId: "t-1",
    })
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

  it("normalises the prompt into the title the Workbench stores", async () => {
    // A long prompt is truncated to MAX_THREAD_TITLE_LENGTH (80) after trimming,
    // exactly as thread-source.ts's touch() does; a 37-char prompt would make
    // this normalisation an identity and prove nothing.
    const longPrompt = `  ${"a".repeat(100)}  `
    const { deps } = fakeDeps({
      threadId: "t-long",
      title: longPrompt.trim().slice(0, 80),
    })
    await expect(
      runWorkbenchBrowserJourney({ ...baseOptions, prompt: longPrompt }, deps),
    ).resolves.toEqual({ threadId: "t-long" })
  })

  it("screenshots and rethrows when restoration fails", async () => {
    const { deps, page } = fakeDeps({ threadId: "t-1", failRestore: true })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).rejects.toThrow(
      /thread rail did not list the prompt/,
    )
    expect(page.screenshot).toHaveBeenCalledTimes(1)
  })

  it("attaches collected console errors when restoration also fails", async () => {
    const { deps } = fakeDeps({
      threadId: "t-1",
      failRestore: true,
      consoleErrors: ["Hydration failed"],
    })
    await expect(runWorkbenchBrowserJourney(baseOptions, deps)).rejects.toThrow(
      /thread rail did not list the prompt[\s\S]*Hydration failed/,
    )
  })
})

describe("findPersistedThreadId", () => {
  it("reports the storage key as absent when localStorage has nothing", () => {
    expect(findPersistedThreadId(null, PROMPT)).toEqual({
      threadId: undefined,
      reason: "storage key absent",
      titles: [],
    })
  })

  it("never throws on malformed JSON", () => {
    const result = findPersistedThreadId("{not json", PROMPT)
    expect(result.threadId).toBeUndefined()
    expect((result as { reason: string }).reason).toBe("storage value is not valid JSON")
  })

  it("reports non-array JSON", () => {
    const result = findPersistedThreadId(JSON.stringify({ not: "an array" }), PROMPT)
    expect(result.threadId).toBeUndefined()
    expect((result as { reason: string }).reason).toBe("storage value is not an array")
  })

  it("reports the stored titles when none matches", () => {
    const raw = JSON.stringify([
      { id: "a", title: "unrelated one" },
      { id: "b", title: "unrelated two" },
    ])
    const result = findPersistedThreadId(raw, PROMPT)
    expect(result.threadId).toBeUndefined()
    expect((result as { titles: readonly string[] }).titles).toEqual([
      "unrelated one",
      "unrelated two",
    ])
    expect((result as { reason: string }).reason).toContain("unrelated one")
  })

  it("reports a matched entry with a non-string id", () => {
    const raw = JSON.stringify([{ id: 42, title: PROMPT }])
    const result = findPersistedThreadId(raw, PROMPT)
    expect(result.threadId).toBeUndefined()
    expect((result as { reason: string }).reason).toBe("entry has no string id")
  })

  it("finds the matching thread's id", () => {
    const raw = JSON.stringify([
      { id: "other", title: "something else" },
      { id: "t-1", title: PROMPT },
    ])
    expect(findPersistedThreadId(raw, PROMPT)).toEqual({ threadId: "t-1" })
  })

  it("takes the first entry with the title, because the list is newest-first", () => {
    const raw = JSON.stringify([
      { id: "newest", title: PROMPT },
      { id: "oldest", title: PROMPT },
    ])
    expect(findPersistedThreadId(raw, PROMPT)).toEqual({ threadId: "newest" })
  })
})
