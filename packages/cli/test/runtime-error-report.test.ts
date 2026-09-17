import { describe, expect, it } from "vitest"

import {
  describeConnectionTarget,
  errorStackOf,
  formatErrorChain,
  serializeError,
} from "../src/lib/dev/runtime-error-report.js"

/**
 * The shape `@neondatabase/serverless` rejects a failed WebSocket connect with:
 * a DOM `ErrorEvent`, not an `Error`. No `stack`, no `cause` — the wrapped
 * `Error` sits on `.error`, and `String(event)` is "[object ErrorEvent]".
 * Node has no `ErrorEvent` global to construct, so this mirrors the spec shape.
 */
class ErrorEvent {
  readonly type = "error"
  readonly message: string
  readonly error: unknown
  constructor(message: string, error: unknown) {
    this.message = message
    this.error = error
  }
}

function withCode<T extends Error>(error: T, code: string): T & { code: string } {
  return Object.assign(error, { code })
}

describe("serializeError", () => {
  it("reads message, code and the wrapped Error off an ErrorEvent-like object", () => {
    const socketError = withCode(new Error("connect ECONNREFUSED 10.0.0.7:5432"), "ECONNREFUSED")
    const event = new ErrorEvent("WebSocket connection failed", socketError)

    expect(String(event)).toBe("[object Object]")
    expect(serializeError(event)).toEqual({
      name: "ErrorEvent",
      message: "WebSocket connection failed",
      cause: {
        message: "connect ECONNREFUSED 10.0.0.7:5432",
        code: "ECONNREFUSED",
      },
    })
  })

  it("follows a `cause` chain and keeps every link's code", () => {
    const root = withCode(new Error("getaddrinfo ENOTFOUND db.internal"), "ENOTFOUND")
    const middle = new TypeError("fetch failed", { cause: root })
    const outer = new Error("postgres checkpointer ready() failed", { cause: middle })

    expect(serializeError(outer)).toEqual({
      message: "postgres checkpointer ready() failed",
      cause: {
        name: "TypeError",
        message: "fetch failed",
        cause: {
          message: "getaddrinfo ENOTFOUND db.internal",
          code: "ENOTFOUND",
        },
      },
    })
  })

  it("prefers `cause` over `error` when an object carries both", () => {
    const serialized = serializeError({
      message: "outer",
      cause: new Error("the cause"),
      error: new Error("the event error"),
    })
    expect(serialized.cause?.message).toBe("the cause")
  })

  it("stringifies a numeric code and ignores an empty one", () => {
    expect(serializeError({ message: "closed", code: 1006 }).code).toBe("1006")
    expect(serializeError({ message: "closed", code: "" })).not.toHaveProperty("code")
  })

  it("names a nameless throw instead of printing an empty message", () => {
    expect(serializeError(new ErrorEvent("", undefined))).toEqual({
      name: "ErrorEvent",
      message: "ErrorEvent without a message",
    })
    expect(serializeError({})).toEqual({ message: "error without a message" })
  })

  it("handles primitives and null without throwing", () => {
    expect(serializeError("boom")).toEqual({ message: "boom" })
    expect(serializeError(42)).toEqual({ message: "42" })
    expect(serializeError(null)).toEqual({ message: "null" })
    expect(serializeError(undefined)).toEqual({ message: "undefined" })
  })

  it("terminates on a circular cause", () => {
    const a = new Error("a")
    const b = new Error("b", { cause: a })
    ;(a as { cause?: unknown }).cause = b

    expect(serializeError(a)).toEqual({
      message: "a",
      cause: { message: "b", cause: { message: "[circular cause]" } },
    })
  })

  it("truncates a runaway chain instead of recursing forever", () => {
    let error: unknown = new Error("leaf")
    for (let index = 0; index < 20; index++) {
      error = new Error(`wrap ${index}`, { cause: error })
    }
    const rendered = formatErrorChain(error)
    expect(rendered).toContain("[cause chain truncated]")
    expect(rendered.split("\n").length).toBeLessThan(12)
  })
})

describe("formatErrorChain", () => {
  it("renders the ErrorEvent, its code and its wrapped Error on operator-readable lines", () => {
    const event = new ErrorEvent(
      "WebSocket connection failed",
      withCode(new Error("connect ECONNREFUSED 10.0.0.7:5432"), "ECONNREFUSED"),
    )
    expect(formatErrorChain(event)).toBe(
      "ErrorEvent: WebSocket connection failed\n" +
        "  caused by: connect ECONNREFUSED 10.0.0.7:5432 (ECONNREFUSED)",
    )
  })

  it("leaves a plain Error's message untouched, the way the log always read", () => {
    expect(formatErrorChain(new Error("DATABASE_URL is not set"))).toBe("DATABASE_URL is not set")
  })
})

describe("errorStackOf", () => {
  it("finds the wrapped Error's stack when the thrown object has none", () => {
    const inner = new Error("connect ECONNREFUSED")
    const event = new ErrorEvent("WebSocket connection failed", inner)
    expect(errorStackOf(event)).toBe(inner.stack)
  })

  it("returns undefined for a primitive or a stackless object", () => {
    expect(errorStackOf("boom")).toBeUndefined()
    expect(errorStackOf({ message: "no stack here" })).toBeUndefined()
  })
})

describe("describeConnectionTarget", () => {
  it("keeps scheme, host, port and database and drops the credentials", () => {
    const target = describeConnectionTarget(
      "postgres://app_user:s3cret-pw@ep-cool-123.us-east-2.aws.neon.tech:5432/b4?sslmode=require",
    )
    expect(target).toBe("postgres://ep-cool-123.us-east-2.aws.neon.tech:5432/b4")
    expect(target).not.toContain("app_user")
    expect(target).not.toContain("s3cret")
    expect(target).not.toContain("sslmode")
  })

  it("drops query parameters, which is where a `password=` can also travel", () => {
    const target = describeConnectionTarget(
      "postgresql://u@db.example.com/prod?password=hunter2&sslrootcert=/etc/ca.pem",
    )
    expect(target).toBe("postgresql://db.example.com/prod")
    expect(target).not.toContain("hunter2")
    expect(target).not.toContain("ca.pem")
  })

  it("never echoes a string the URL parser rejects", () => {
    const target = describeConnectionTarget("host=db.internal user=app password=hunter2 dbname=b4")
    expect(target).toBe("an unparseable connection string (redacted)")
    expect(target).not.toContain("hunter2")
    expect(target).not.toContain("db.internal")
  })

  it("survives a connection string with no database or port", () => {
    expect(describeConnectionTarget("postgres://db.internal")).toBe("postgres://db.internal")
  })
})
