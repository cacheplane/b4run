import type { B4Middleware, MiddlewareRequest } from "@b4run/sdk"
import { describe, expect, test } from "vitest"
import { bindMiddleware, runMiddleware, selectMiddlewareExport } from "../src/lib/dev/middleware.js"

function createMockRequest(overrides?: Partial<MiddlewareRequest>): MiddlewareRequest {
  return {
    assistantId: "/hello/[tenant]#agent",
    headers: {},
    method: "POST",
    params: {},
    routeId: "/hello/[tenant]",
    url: "/runs/wait",
    ...overrides,
  }
}

describe("runMiddleware", () => {
  test("returns continue when middleware is undefined", async () => {
    const result = await runMiddleware(undefined, createMockRequest())
    expect(result.action).toBe("continue")
  })

  test("returns continue when middleware passes", async () => {
    const mw: B4Middleware = async () => ({ action: "continue" })

    const result = await runMiddleware(mw, createMockRequest())
    expect(result.action).toBe("continue")
  })

  test("returns reject when middleware rejects", async () => {
    const mw: B4Middleware = async () => ({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })

    const result = await runMiddleware(mw, createMockRequest())
    expect(result).toEqual({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })
  })

  test("passes context through on continue", async () => {
    const mw: B4Middleware = async () => ({
      action: "continue",
      context: { userId: "user-1" },
    })

    const result = await runMiddleware(mw, createMockRequest())
    expect(result).toEqual({
      action: "continue",
      context: { userId: "user-1" },
    })
  })

  test("receives parsed request with headers and params", async () => {
    let receivedReq: MiddlewareRequest | undefined

    const mw: B4Middleware = async (req) => {
      receivedReq = req
      return { action: "continue" }
    }

    await runMiddleware(
      mw,
      createMockRequest({
        headers: { authorization: "Bearer tok-123" },
        params: { tenant: "acme" },
        routeId: "/api/chat",
      }),
    )

    expect(receivedReq?.headers.authorization).toBe("Bearer tok-123")
    expect(receivedReq?.params.tenant).toBe("acme")
    expect(receivedReq?.routeId).toBe("/api/chat")
  })
})

describe("bindMiddleware", () => {
  const ctx = { appRoot: "/app" }

  test("binds undefined to no handler and a no-op dispose", async () => {
    const bound = bindMiddleware(undefined, ctx)
    expect(bound.handler).toBeUndefined()
    await expect(bound.dispose()).resolves.toBeUndefined()
  })

  test("binds a plain function as itself", async () => {
    const mw: B4Middleware = async () => ({ action: "continue" })
    const bound = bindMiddleware(mw, ctx)
    expect(bound.handler).toBe(mw)
    await expect(bound.dispose()).resolves.toBeUndefined()
  })

  test("does not run setup at bind time, only before the first request", async () => {
    let setupCalls = 0
    let seenCtx: { readonly appRoot: string } | undefined
    const bound = bindMiddleware(
      {
        setup: (c) => {
          setupCalls++
          seenCtx = c
        },
        handle: () => ({ action: "continue" }),
      },
      ctx,
    )
    expect(setupCalls).toBe(0)

    const result = await runMiddleware(bound.handler, createMockRequest())
    expect(result.action).toBe("continue")
    expect(setupCalls).toBe(1)
    expect(seenCtx).toEqual({ appRoot: "/app" })

    await runMiddleware(bound.handler, createMockRequest())
    expect(setupCalls).toBe(1)
  })

  test("concurrent first requests share one in-flight setup", async () => {
    let setupCalls = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const bound = bindMiddleware(
      {
        setup: async () => {
          setupCalls++
          await gate
        },
        handle: () => ({ action: "continue" }),
      },
      ctx,
    )
    const first = runMiddleware(bound.handler, createMockRequest())
    const second = runMiddleware(bound.handler, createMockRequest())
    release()
    const results = await Promise.all([first, second])
    expect(results.map((r) => r.action)).toEqual(["continue", "continue"])
    expect(setupCalls).toBe(1)
  })

  test("a failed setup rejects that request, skips handle, and is retried by the next request", async () => {
    let setupCalls = 0
    let handleCalls = 0
    const bound = bindMiddleware(
      {
        setup: async () => {
          setupCalls++
          if (setupCalls === 1) throw new Error("db down")
        },
        handle: () => {
          handleCalls++
          return { action: "continue" }
        },
      },
      ctx,
    )

    await expect(runMiddleware(bound.handler, createMockRequest())).rejects.toThrow("db down")
    expect(handleCalls).toBe(0)

    const result = await runMiddleware(bound.handler, createMockRequest())
    expect(result.action).toBe("continue")
    expect(setupCalls).toBe(2)
    expect(handleCalls).toBe(1)
  })

  test("dispose runs after a successful setup, once", async () => {
    const events: string[] = []
    const bound = bindMiddleware(
      {
        setup: () => {
          events.push("setup")
        },
        dispose: () => {
          events.push("dispose")
        },
        handle: () => ({ action: "continue" }),
      },
      ctx,
    )
    await runMiddleware(bound.handler, createMockRequest())
    await bound.dispose()
    await bound.dispose()
    expect(events).toEqual(["setup", "dispose"])
  })

  test("dispose is skipped when setup never ran", async () => {
    let disposeCalls = 0
    const bound = bindMiddleware(
      {
        setup: () => undefined,
        dispose: () => {
          disposeCalls++
        },
        handle: () => ({ action: "continue" }),
      },
      ctx,
    )
    await bound.dispose()
    expect(disposeCalls).toBe(0)
  })

  test("dispose is skipped when setup only ever failed", async () => {
    let disposeCalls = 0
    const bound = bindMiddleware(
      {
        setup: () => {
          throw new Error("db down")
        },
        dispose: () => {
          disposeCalls++
        },
        handle: () => ({ action: "continue" }),
      },
      ctx,
    )
    await expect(runMiddleware(bound.handler, createMockRequest())).rejects.toThrow("db down")
    await bound.dispose()
    expect(disposeCalls).toBe(0)
  })

  test("dispose waits for an in-flight setup", async () => {
    const events: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const bound = bindMiddleware(
      {
        setup: async () => {
          await gate
          events.push("setup")
        },
        dispose: () => {
          events.push("dispose")
        },
        handle: () => ({ action: "continue" }),
      },
      ctx,
    )
    const request = runMiddleware(bound.handler, createMockRequest())
    const disposing = bound.dispose()
    release()
    await request
    await disposing
    expect(events).toEqual(["setup", "dispose"])
  })

  test("dispose runs without a setup hook", async () => {
    let disposeCalls = 0
    const bound = bindMiddleware(
      {
        dispose: () => {
          disposeCalls++
        },
        handle: () => ({ action: "continue" }),
      },
      ctx,
    )
    await bound.dispose()
    expect(disposeCalls).toBe(1)
  })

  test("a request after dispose fails instead of re-running setup", async () => {
    let setupCalls = 0
    const bound = bindMiddleware(
      {
        setup: () => {
          setupCalls++
        },
        handle: () => ({ action: "continue" }),
      },
      ctx,
    )
    await runMiddleware(bound.handler, createMockRequest())
    await bound.dispose()
    await expect(runMiddleware(bound.handler, createMockRequest())).rejects.toThrow(/disposed/)
    expect(setupCalls).toBe(1)
  })
})

describe("selectMiddlewareExport", () => {
  test("selects a lifecycle definition object", () => {
    const definition = { handle: () => ({ action: "continue" }) as const }
    expect(selectMiddlewareExport({ default: definition })).toBe(definition)
    expect(selectMiddlewareExport({ middleware: definition })).toBe(definition)
  })

  test("ignores an object without a handle function", () => {
    expect(selectMiddlewareExport({ default: { setup: () => undefined } })).toBeUndefined()
  })
})
