import { describe, expect, test } from "vitest"

import { normalizeWsProxy, selectPostgresDriver } from "../src/lib/runtime/postgres-driver.ts"

// ---------------------------------------------------------------------------
// The pure decisions the emitted `stores.mjs` makes before opening a pool:
// which driver talks to DATABASE_URL, and what B4_PG_WS_PROXY means. Both are
// exported through `@b4run/cli/fetch` so the generated file and these tests
// exercise the SAME code rather than a copy.
// ---------------------------------------------------------------------------

describe("normalizeWsProxy", () => {
  test("accepts the bare host:port form the driver has always taken", () => {
    expect(normalizeWsProxy("127.0.0.1:54321")).toEqual({
      address: "127.0.0.1:54321",
      secure: false,
    })
  })

  test("accepts and strips a ws:// prefix", () => {
    expect(normalizeWsProxy("ws://localhost:8080")).toEqual({
      address: "localhost:8080",
      secure: false,
    })
  })

  test("accepts a wss:// prefix and keeps the socket secure", () => {
    expect(normalizeWsProxy("wss://proxy.example.com:443")).toEqual({
      address: "proxy.example.com:443",
      secure: true,
    })
  })

  test("tolerates surrounding whitespace and a trailing slash", () => {
    expect(normalizeWsProxy("  ws://localhost:8080/ ")).toEqual({
      address: "localhost:8080",
      secure: false,
    })
  })

  test("treats an empty value as unset", () => {
    expect(normalizeWsProxy("")).toBeUndefined()
    expect(normalizeWsProxy("   ")).toBeUndefined()
    expect(normalizeWsProxy(undefined)).toBeUndefined()
  })

  test("rejects a scheme other than ws or wss, naming the value and the accepted forms", () => {
    expect(() => normalizeWsProxy("http://localhost:8080")).toThrow(
      /B4_PG_WS_PROXY must be host:port, optionally prefixed with ws:\/\/ or wss:\/\/.*"http:\/\/localhost:8080"/,
    )
  })

  test("rejects a path or query, which the driver appends itself", () => {
    expect(() => normalizeWsProxy("localhost:8080/v1")).toThrow(/B4_PG_WS_PROXY/)
    expect(() => normalizeWsProxy("ws://localhost:8080?address=x")).toThrow(/B4_PG_WS_PROXY/)
  })
})

describe("selectPostgresDriver", () => {
  const neonUrl =
    "postgres://user:pw@ep-cool-lab-123456.us-east-2.aws.neon.tech/neondb?sslmode=require"
  const localUrl = "postgres://user:pw@localhost:5432/app"

  test("vercel: a Neon host uses the neon driver with no proxy", () => {
    expect(selectPostgresDriver({ databaseUrl: neonUrl, target: "vercel" })).toEqual({
      driver: "neon",
    })
  })

  test("vercel: a non-Neon host falls back to pg so a local Postgres needs no proxy", () => {
    expect(selectPostgresDriver({ databaseUrl: localUrl, target: "vercel" })).toEqual({
      driver: "pg",
    })
  })

  test("vercel: a configured proxy keeps the neon driver for a non-Neon host", () => {
    expect(
      selectPostgresDriver({
        databaseUrl: localUrl,
        target: "vercel",
        wsProxy: "ws://localhost:8080",
      }),
    ).toEqual({ driver: "neon", wsProxy: { address: "localhost:8080", secure: false } })
  })

  test("vercel: B4_PG_DRIVER=pg forces pg even for a Neon host", () => {
    expect(selectPostgresDriver({ databaseUrl: neonUrl, driver: "pg", target: "vercel" })).toEqual({
      driver: "pg",
    })
  })

  test("vercel: B4_PG_DRIVER=neon forces neon for a local host", () => {
    expect(
      selectPostgresDriver({ databaseUrl: localUrl, driver: "neon", target: "vercel" }),
    ).toEqual({
      driver: "neon",
    })
  })

  test("B4_PG_DRIVER is trimmed and case-insensitive", () => {
    expect(
      selectPostgresDriver({ databaseUrl: neonUrl, driver: " PG ", target: "vercel" }),
    ).toEqual({ driver: "pg" })
  })

  test("rejects an unknown B4_PG_DRIVER value, naming the accepted ones", () => {
    expect(() =>
      selectPostgresDriver({ databaseUrl: localUrl, driver: "mysql", target: "vercel" }),
    ).toThrow(/B4_PG_DRIVER must be "neon" or "pg".*"mysql"/)
  })

  test("rejects a proxy combined with an explicit pg driver rather than ignoring one of them", () => {
    expect(() =>
      selectPostgresDriver({
        databaseUrl: localUrl,
        driver: "pg",
        target: "vercel",
        wsProxy: "localhost:8080",
      }),
    ).toThrow(/B4_PG_WS_PROXY.*B4_PG_DRIVER=pg/)
  })

  test("an unparseable DATABASE_URL is left to the driver to reject, not guessed as Neon", () => {
    expect(selectPostgresDriver({ databaseUrl: "not a url", target: "vercel" })).toEqual({
      driver: "pg",
    })
  })

  test("hono: always neon, with the normalised proxy when one is set", () => {
    expect(selectPostgresDriver({ databaseUrl: localUrl, target: "hono" })).toEqual({
      driver: "neon",
    })
    expect(
      selectPostgresDriver({ databaseUrl: localUrl, target: "hono", wsProxy: "127.0.0.1:1234" }),
    ).toEqual({ driver: "neon", wsProxy: { address: "127.0.0.1:1234", secure: false } })
  })

  test("hono: B4_PG_DRIVER=pg is refused because workerd has no TCP sockets for pg", () => {
    expect(() =>
      selectPostgresDriver({ databaseUrl: localUrl, driver: "pg", target: "hono" }),
    ).toThrow(/B4_PG_DRIVER=pg is not supported on the hono target/)
  })

  test("a malformed proxy fails selection with the normalisation message", () => {
    expect(() =>
      selectPostgresDriver({ databaseUrl: localUrl, target: "vercel", wsProxy: "http://x:1" }),
    ).toThrow(/B4_PG_WS_PROXY must be host:port/)
  })
})
