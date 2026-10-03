import type { Browser, BrowserContext, Page } from "@playwright/test"
import { describe, expect, it, vi } from "vitest"

import {
  COLLECTED_ERRORS_BACKSTOP_MESSAGE,
  JOURNEY_ABORTED_MESSAGE,
  type WorkbenchPageDeps,
  withWorkbenchPage,
} from "./workbench-page.ts"

/**
 * A fake Chromium whose page records its listeners, so a test can emit the
 * console errors a real page would emit from inside the body. `calls` records
 * the teardown order the seam is responsible for.
 */
function fakePage() {
  const listeners = new Map<string, (payload: unknown) => void>()
  const calls: string[] = []
  const page = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
    }),
    screenshot: vi.fn(async () => {
      calls.push("screenshot")
    }),
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
  const chromium = { launch: vi.fn(async () => browser) }
  const deps: WorkbenchPageDeps = { chromium }
  const emitConsoleError = (text: string, url = "") => {
    listeners.get("console")?.({ type: () => "error", text: () => text, location: () => ({ url }) })
  }
  const emitConsoleWarning = (text: string) => {
    listeners.get("console")?.({
      type: () => "warning",
      text: () => text,
      location: () => ({ url: "" }),
    })
  }
  const emitPageError = (message: string) => {
    listeners.get("pageerror")?.(new Error(message))
  }
  return { calls, chromium, deps, page, emitConsoleError, emitConsoleWarning, emitPageError }
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

const PROBE_404 = "Failed to load resource: the server responded with a status of 404 (Not Found)"

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

  it("closes the context before the browser", async () => {
    const { calls, deps } = fakePage()
    await withWorkbenchPage({ screenshotPath: "/tmp/never-written.png" }, deps, async () => "ok")
    expect(calls).toEqual(["context.close", "browser.close"])
  })

  it("refuses to launch a browser for an already-aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    const { deps, chromium } = fakePage()
    await expect(
      withWorkbenchPage(
        { screenshotPath: "/tmp/never-written.png", signal: controller.signal },
        deps,
        async () => "never",
      ),
    ).rejects.toThrow(JOURNEY_ABORTED_MESSAGE)
    expect(chromium.launch).not.toHaveBeenCalled()
  })

  it("rejects and closes the browser when the signal aborts mid-body", async () => {
    const controller = new AbortController()
    const { calls, deps } = fakePage()
    await expect(
      withWorkbenchPage(
        { screenshotPath: "/tmp/aborted.png", signal: controller.signal },
        deps,
        async () => {
          // The harness deadline can fire at any point; mid-body is the
          // interesting one — the body itself never settles.
          controller.abort()
          return new Promise<string>(() => undefined)
        },
      ),
    ).rejects.toThrow(JOURNEY_ABORTED_MESSAGE)
    expect(calls).toContain("browser.close")
  })

  it("tolerates the hydrate probes' 404s on a brand-new thread", async () => {
    const { deps, emitConsoleError } = fakePage()
    await expect(
      withWorkbenchPage({ screenshotPath: "/tmp/never-written.png" }, deps, async () => {
        emitConsoleError(PROBE_404, "http://127.0.0.1:4712/api/b4/threads/t-1/state")
        emitConsoleError(PROBE_404, "http://127.0.0.1:4712/api/b4/threads/t-1/pending_interrupts")
        return "ok"
      }),
    ).resolves.toBe("ok")
  })

  it("fails on a 500 from a hydrate probe", async () => {
    const { deps, emitConsoleError } = fakePage()
    await expect(
      withWorkbenchPage({ screenshotPath: "/tmp/probe-500.png" }, deps, async () => {
        emitConsoleError(
          "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
          "http://127.0.0.1:4712/api/b4/threads/t-1/state",
        )
        return "ok"
      }),
    ).rejects.toThrow(/status of 500[\s\S]*threads\/t-1\/state/)
  })

  it("fails on a 404 from a path that is not a hydrate probe", async () => {
    const { deps, emitConsoleError } = fakePage()
    await expect(
      withWorkbenchPage({ screenshotPath: "/tmp/probe-404.png" }, deps, async () => {
        emitConsoleError(PROBE_404, "http://127.0.0.1:4712/api/b4/threads/x/other")
        return "ok"
      }),
    ).rejects.toThrow(/threads\/x\/other/)
  })

  it("collects an uncaught page error", async () => {
    const { deps, emitPageError } = fakePage()
    await expect(
      withWorkbenchPage({ screenshotPath: "/tmp/pageerror.png" }, deps, async () => {
        emitPageError("boom")
        return "ok"
      }),
    ).rejects.toThrow(/pageerror: boom/)
  })

  it("ignores a console warning (only errors fail)", async () => {
    const { deps, emitConsoleWarning } = fakePage()
    await expect(
      withWorkbenchPage({ screenshotPath: "/tmp/never-written.png" }, deps, async () => {
        emitConsoleWarning("deprecated API")
        return "ok"
      }),
    ).resolves.toBe("ok")
  })
})
