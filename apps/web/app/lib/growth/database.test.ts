import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"

const pools: EventEmitter[] = []
const poolOptions: Record<string, unknown>[] = []

vi.mock("pg", () => ({
  Pool: class extends EventEmitter {
    constructor(options: Record<string, unknown>) {
      super()
      pools.push(this)
      poolOptions.push(options)
    }
  },
}))

import { createPgExecutor } from "./database"

afterEach(() => {
  pools.length = 0
  poolOptions.length = 0
  vi.restoreAllMocks()
})

describe("createPgExecutor", () => {
  it("logs pool errors to stderr instead of crashing", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    createPgExecutor("postgres://u:p@localhost:5432/db")
    expect(() => pools[0]?.emit("error", new Error("connection lost"))).not.toThrow()
    expect(write).toHaveBeenCalledWith("growth database pool error: connection lost\n")
  })

  it("uses SSL only for non-local hosts", () => {
    for (const url of [
      "postgres://u:p@localhost/db",
      "postgres://u:p@127.0.0.1/db",
      "postgres://u:p@[::1]/db",
      "postgres://u:p@db.example.com/db",
    ]) {
      createPgExecutor(url)
    }
    expect(poolOptions.map((options) => "ssl" in options)).toEqual([false, false, false, true])
  })
})
