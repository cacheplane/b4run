import { EventEmitter } from "node:events"
import type { ClientConfig } from "pg"
import { afterEach, describe, expect, it, test, vi } from "vitest"

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

test.each(["prefer", "require", "verify-ca"])(
  "preserves full certificate verification explicitly for sslmode=%s",
  (mode) => {
    const input = `postgres://u:p%40ss%3Aword@db.example.com/db?sslmode=${mode}&channel_binding=require&application_name=growth`

    createPgExecutor(input)

    const options = poolOptions[0]
    const url = new URL(options?.connectionString as string)
    expect(url.searchParams.get("sslmode")).toBe("verify-full")
    expect(url.username).toBe("u")
    expect(url.password).toBe("p%40ss%3Aword")
    expect(url.searchParams.get("channel_binding")).toBe("require")
    expect(url.searchParams.get("application_name")).toBe("growth")
    expect(options?.ssl).toEqual({ rejectUnauthorized: true })
  },
)

test.each([
  "postgres://u:p@localhost/db",
  "postgres://u:p@127.0.0.1/db",
  "postgres://u:p@[::1]/db",
  "postgres://u:p@db.example.com/db",
  "postgres://u:p@db.example.com/db?sslmode=verify-full",
  "postgres://u:p@localhost/db?sslmode=disable",
  ...["prefer", "require", "verify-ca"].map(
    (mode) => `postgres://u:p@db.example.com/db?sslmode=${mode}&uselibpqcompat=true`,
  ),
])("preserves an already explicit connection policy: %s", (input) => {
  createPgExecutor(input)

  expect(poolOptions[0]?.connectionString).toBe(input)
})

test("the real pg parser retains verified TLS without the SSL-mode warning", async () => {
  const { Client } = await vi.importActual<typeof import("pg")>("pg")
  const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined)
  createPgExecutor("postgres://u:p@db.example.com/db?sslmode=require")

  const client = new Client(poolOptions[0] as ClientConfig)

  expect(client.ssl).toBeTruthy()
  expect(client.ssl).not.toMatchObject({ rejectUnauthorized: false })
  expect(warn).not.toHaveBeenCalled()
})
