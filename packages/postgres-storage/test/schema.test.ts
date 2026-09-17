import { describe, expect, it } from "vitest"
import {
  assertIdentifier,
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  IDENTIFIER_PATTERN,
  postgresCheckpointer,
} from "../src/index.js"
import { qualify } from "../src/schema.js"

describe("assertIdentifier", () => {
  it("accepts valid SQL identifiers", () => {
    expect(() => assertIdentifier("tablePrefix", "b4")).not.toThrow()
    expect(() => assertIdentifier("schema", "public")).not.toThrow()
    expect(() => assertIdentifier("tablePrefix", "_ckpt_v2")).not.toThrow()
    expect(() => assertIdentifier("tablePrefix", "t_9")).not.toThrow()
    expect(() => assertIdentifier("schema", "production")).not.toThrow()
  })
  it("rejects mixed case, which unquoted DDL would silently fold to lowercase", () => {
    // `MySchema` interpolated unquoted creates `myschema`, so the configured
    // name and the real name would differ — and so would the advisory-lock key.
    expect(() => assertIdentifier("schema", "MySchema")).toThrow(/lowercase/)
    expect(() => assertIdentifier("tablePrefix", "B4")).toThrow(/tablePrefix/)
  })
  it("exposes the pattern it enforces, for wiring that validates before construction", () => {
    expect(IDENTIFIER_PATTERN.source).toBe("^[a-z_][a-z0-9_]*$")
    expect(IDENTIFIER_PATTERN.flags).toBe("")
  })
  it("rejects identifiers with unsafe characters", () => {
    expect(() => assertIdentifier("tablePrefix", "bad-name")).toThrow(/tablePrefix/)
    expect(() => assertIdentifier("schema", "public; DROP TABLE x")).toThrow(/schema/)
    expect(() => assertIdentifier("tablePrefix", "1leading")).toThrow(/tablePrefix/)
    expect(() => assertIdentifier("schema", "")).toThrow(/schema/)
    expect(() => assertIdentifier("schema", 'pub"lic')).toThrow(/schema/)
    expect(() => assertIdentifier("tablePrefix", "with space")).toThrow(/tablePrefix/)
  })
  it("names the package in the error so a bad config is traceable", () => {
    expect(() => assertIdentifier("schema", "-")).toThrow(/postgres-storage/)
  })
})

describe("qualify", () => {
  it("joins schema, prefix and logical table name", () => {
    expect(qualify({ schema: DEFAULT_SCHEMA, prefix: DEFAULT_TABLE_PREFIX }, "checkpoints")).toBe(
      "public.b4_checkpoints",
    )
    expect(qualify({ schema: "app", prefix: "t_1" }, "writes")).toBe("app.t_1_writes")
  })
})

describe("postgresCheckpointer construction", () => {
  it("rejects an unsafe schema or table prefix before any connection is made", () => {
    expect(() => postgresCheckpointer({ schema: "public; DROP TABLE x" })).toThrow(/schema/)
    expect(() => postgresCheckpointer({ tablePrefix: "bad-prefix" })).toThrow(/tablePrefix/)
  })
})
