import { describe, expect, test } from "vitest"
import {
  allow,
  defineMiddleware,
  type MiddlewareAfterResult,
  type MiddlewareAfterRun,
  type MiddlewareRequest,
  type MiddlewareResult,
  reject,
} from "../src/middleware.js"

describe("reject()", () => {
  test("returns a reject result with status and body", () => {
    const result = reject(401, { error: "Unauthorized" })
    expect(result).toEqual({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })
  })

  test("omits body when not provided", () => {
    const result = reject(403)
    expect(result).toStrictEqual({ action: "reject", status: 403 })
    expect(Object.hasOwn(result, "body")).toBe(false)
  })
})

describe("allow()", () => {
  test("returns a continue result with context", () => {
    const result = allow({ userId: "user-1", orgId: "org-1" })
    expect(result).toEqual({
      action: "continue",
      context: { userId: "user-1", orgId: "org-1" },
    })
  })

  test("omits context when not provided", () => {
    const result = allow()
    expect(result).toStrictEqual({ action: "continue" })
    expect(Object.hasOwn(result, "context")).toBe(false)
  })
})

describe("defineMiddleware()", () => {
  test("returns the function as-is (type-safe identity wrapper)", () => {
    const fn = async (_req: MiddlewareRequest): Promise<MiddlewareResult> => {
      return allow()
    }

    const middleware = defineMiddleware(fn)
    expect(middleware).toBe(fn)
  })

  test("works with a sync function", () => {
    const fn = (_req: MiddlewareRequest): MiddlewareResult => {
      return reject(401)
    }

    const middleware = defineMiddleware(fn)
    expect(middleware).toBe(fn)
  })
})

describe("defineMiddleware() — lifecycle object form", () => {
  test("returns the definition as-is with setup, dispose and handle", () => {
    const definition = {
      setup: async (_ctx: { readonly appRoot: string }) => undefined,
      dispose: async () => undefined,
      handle: (_req: MiddlewareRequest): MiddlewareResult => allow(),
    }

    const middleware = defineMiddleware(definition)
    expect(middleware).toBe(definition)
  })

  test("accepts a definition with only handle", () => {
    const definition = { handle: () => reject(401) }
    expect(defineMiddleware(definition)).toBe(definition)
  })
})

describe("defineMiddleware() — after hook", () => {
  test("accepts a definition with handle and after, and returns it as-is", () => {
    const definition = {
      handle: (_req: MiddlewareRequest): MiddlewareResult => allow({ tenant: "acme" }),
      after: (run: MiddlewareAfterRun): MiddlewareAfterResult =>
        run.context?.tenant === "acme" ? { finalMessage: run.finalMessage.trim() } : reject(403),
    }
    expect(defineMiddleware(definition)).toBe(definition)
  })

  test("after may return nothing to leave the final message untouched", () => {
    const definition = {
      handle: () => allow(),
      after: (_run: MiddlewareAfterRun) => undefined,
    }
    expect(defineMiddleware(definition)).toBe(definition)
  })
})
