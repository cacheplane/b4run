import type { Browser, BrowserContext, Page } from "@playwright/test"
import { describe, expect, it, vi } from "vitest"

import {
  COLLECTED_ERRORS_BACKSTOP_MESSAGE,
  type WorkbenchPageDeps,
  withWorkbenchPage,
} from "./workbench-page.ts"

/**
 * A fake Chromium whose page records its listeners, so a test can emit the
 * console errors a real page would emit from inside the body.
 */
function fakePage() {
  const listeners = new Map<string, (payload: unknown) => void>()
  const page = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
    }),
    screenshot: vi.fn(async () => undefined),
  } as unknown as Page
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  } as unknown as BrowserContext
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  } as unknown as Browser
  const deps: WorkbenchPageDeps = { chromium: { launch: vi.fn(async () => browser) } }
  const emitConsoleError = (text: string, url = "") => {
    listeners.get("console")?.({ type: () => "error", text: () => text, location: () => ({ url }) })
  }
  return { deps, page, emitConsoleError }
}

/** Returns the error a call rejected with, failing if it resolved instead. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the call to reject, but it resolved")
}

describe("withWorkbenchPage", () => {
  it("resolves a screenshotPath function at failure time, not at call time", async () => {
    const { deps, page } = fakePage()
    let target = "/tmp/before-the-body-ran.png"
    await expect(
      withWorkbenchPage({ screenshotPath: () => target }, deps, async () => {
        target = "/tmp/named-for-this-journey.png"
        throw new Error("the body blew up")
      }),
    ).rejects.toThrow(/the body blew up/)
    expect(page.screenshot).toHaveBeenCalledWith({
      path: "/tmp/named-for-this-journey.png",
      fullPage: true,
    })
  })

  it("fails a body that returned normally while a console error was collected", async () => {
    const { deps, page, emitConsoleError } = fakePage()
    await expect(
      withWorkbenchPage({ screenshotPath: "/tmp/backstop.png" }, deps, async () => {
        emitConsoleError("Hydration failed")
        return "the body did not check"
      }),
    ).rejects.toThrow(COLLECTED_ERRORS_BACKSTOP_MESSAGE)
    expect(page.screenshot).toHaveBeenCalledWith({ path: "/tmp/backstop.png", fullPage: true })
  })

  it("states the collected-errors heading once when the backstop fires", async () => {
    const { deps, emitConsoleError } = fakePage()
    const rejection = await rejectionOf(
      withWorkbenchPage({ screenshotPath: "/tmp/backstop.png" }, deps, async () => {
        emitConsoleError("Hydration failed")
        return "the body did not check"
      }),
    )
    expect(rejection.message).toContain("Hydration failed")
    expect(rejection.message).not.toContain("before the failure")
    expect(rejection.message.match(/Workbench console errors/g)).toHaveLength(1)
  })

  it("keeps the real failure when the screenshot resolver throws", async () => {
    const { deps, page } = fakePage()
    const rejection = await rejectionOf(
      withWorkbenchPage(
        {
          screenshotPath: () => {
            throw new Error("the resolver is caller code")
          },
        },
        deps,
        async () => {
          throw new Error("THE REAL PLAYWRIGHT TIMEOUT", { cause: "call log" })
        },
      ),
    )
    expect(rejection.message).toBe("THE REAL PLAYWRIGHT TIMEOUT")
    expect(rejection.cause).toBe("call log")
    expect(page.screenshot).not.toHaveBeenCalled()
  })
})
