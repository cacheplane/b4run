import { describe, expect, it, vi } from "vitest"

const create = vi.hoisted(() => vi.fn(() => ({ marker: true })))
vi.mock("../database", () => ({ createPgExecutor: create }))

import { getSharedExecutor } from "./shared"

describe("getSharedExecutor", () => {
  it("memoises per process and refuses a different URL", () => {
    const first = getSharedExecutor("postgres://a")
    expect(getSharedExecutor("postgres://a")).toBe(first)
    expect(create).toHaveBeenCalledTimes(1)
    expect(() => getSharedExecutor("postgres://b")).toThrow(
      "growth executor already created for a different database URL",
    )
  })
})
