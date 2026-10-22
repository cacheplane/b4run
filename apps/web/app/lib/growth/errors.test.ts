import { describe, expect, it } from "vitest"
import { errorLogCode, GrowthConfigError, safeErrorCode } from "./errors"

describe("safeErrorCode", () => {
  it("keeps only short machine error codes", () => {
    expect(safeErrorCode("http_500")).toBe("http_500")
    expect(safeErrorCode("idempotency_mismatch")).toBe("idempotency_mismatch")
    expect(safeErrorCode("bad ada@example.com")).toBe("unclassified")
    expect(safeErrorCode("")).toBe("unclassified")
    expect(safeErrorCode("x".repeat(65))).toBe("unclassified")
  })
})

describe("errorLogCode", () => {
  it("logs a driver's code in lower case, never the message", () => {
    const error = Object.assign(new Error("ada@example.com broke"), { code: "ECONNREFUSED" })
    expect(errorLogCode(error)).toBe("econnrefused")
  })

  it("logs unclassified for an error without a usable code", () => {
    expect(errorLogCode(new Error("GROWTH_DATABASE_URL is not set"))).toBe("unclassified")
    expect(errorLogCode(Object.assign(new Error("x"), { code: "has space" }))).toBe("unclassified")
    expect(errorLogCode("plain string")).toBe("unclassified")
    expect(errorLogCode(null)).toBe("unclassified")
  })

  it("logs config_invalid for a configuration error and keeps its message out", () => {
    const error = new GrowthConfigError("RESEND_API_KEY is not set")
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe("config_invalid")
    expect(error.message).toBe("RESEND_API_KEY is not set")
    expect(errorLogCode(error)).toBe("config_invalid")
  })
})
