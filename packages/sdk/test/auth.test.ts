import { describe, expect, test } from "vitest"
import { defineAuth, isAuthDefinition, reject } from "../src/index.js"

describe("defineAuth", () => {
  test("brands the definition so the runtime can tell it from a plain object", () => {
    const authenticate = () => ({ id: "u-1" })
    const auth = defineAuth({ authenticate })
    expect(isAuthDefinition(auth)).toBe(true)
    expect(auth.authenticate).toBe(authenticate)
    expect(Object.isFrozen(auth)).toBe(true)
    expect(isAuthDefinition({ authenticate })).toBe(false)
  })

  test("keeps setup and dispose", () => {
    const setup = () => undefined
    const dispose = () => undefined
    const auth = defineAuth({ authenticate: () => undefined, dispose, setup })
    expect(auth.setup).toBe(setup)
    expect(auth.dispose).toBe(dispose)
  })

  test("refuses a definition without an authenticate function", () => {
    expect(() => defineAuth({} as never)).toThrow(/authenticate/)
  })

  test("authenticate may answer with a principal, anonymous, or a rejection", async () => {
    const auth = defineAuth({
      authenticate: ({ headers }) =>
        headers.authorization === undefined
          ? undefined
          : headers.authorization === "Bearer ok"
            ? { id: "u-1", role: "admin" }
            : reject(401, { error: "unauthorized" }),
    })
    const request = (headers: Record<string, string>) => ({ headers, method: "GET", url: "/" })
    expect(await auth.authenticate(request({}))).toBeUndefined()
    expect(await auth.authenticate(request({ authorization: "Bearer ok" }))).toEqual({
      id: "u-1",
      role: "admin",
    })
    expect(await auth.authenticate(request({ authorization: "Bearer no" }))).toEqual({
      action: "reject",
      body: { error: "unauthorized" },
      status: 401,
    })
  })

  test("isAuthDefinition rejects non-objects", () => {
    expect(isAuthDefinition(undefined)).toBe(false)
    expect(isAuthDefinition(null)).toBe(false)
    expect(isAuthDefinition(() => undefined)).toBe(false)
  })
})
