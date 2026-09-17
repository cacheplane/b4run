import { describe, expect, it } from "vitest"
import { pgvectorMemoryStore } from "../src/index.js"
import { assertIdentifier, IDENTIFIER_PATTERN, vectorColumnDef } from "../src/schema.js"

describe("vectorColumnDef", () => {
  it("dims ≤ 2000 → plain vector + vector_cosine_ops", () => {
    expect(vectorColumnDef(1536)).toEqual({ type: "vector(1536)", ops: "vector_cosine_ops" })
  })
  it("2000 < dims ≤ 4000 → halfvec + halfvec_cosine_ops (text-embedding-3-large)", () => {
    expect(vectorColumnDef(3072)).toEqual({ type: "halfvec(3072)", ops: "halfvec_cosine_ops" })
  })
  it("dims > 4000 → throws a clear error naming the ceiling", () => {
    expect(() => vectorColumnDef(5000)).toThrow(/4000/)
  })
  it("non-positive/non-integer dims throw", () => {
    expect(() => vectorColumnDef(0)).toThrow()
    expect(() => vectorColumnDef(1.5)).toThrow()
  })
})

describe("assertIdentifier", () => {
  it("accepts valid SQL identifiers", () => {
    expect(() => assertIdentifier("prefix", "b4")).not.toThrow()
    expect(() => assertIdentifier("schema", "public")).not.toThrow()
    expect(() => assertIdentifier("prefix", "_mem_v2")).not.toThrow()
    expect(() => assertIdentifier("schema", "b4_memory")).not.toThrow()
  })
  it("rejects identifiers with unsafe characters", () => {
    expect(() => assertIdentifier("prefix", "bad-name")).toThrow(/prefix/)
    expect(() => assertIdentifier("schema", "public; DROP TABLE x")).toThrow(/schema/)
    expect(() => assertIdentifier("prefix", "1leading")).toThrow(/prefix/)
    expect(() => assertIdentifier("schema", "")).toThrow(/schema/)
  })
  it("rejects mixed case, which unquoted DDL would silently fold to lowercase", () => {
    // `initSchema` interpolates these UNQUOTED, and Postgres folds an unquoted
    // identifier to lowercase — so `MySchema` created `myschema` and the
    // configured name never named the tables the store then queried.
    // `@b4run/postgres-storage` enforces the same rule for the same reason.
    expect(() => assertIdentifier("schema", "MySchema")).toThrow(/lowercase/)
    expect(() => assertIdentifier("prefix", "B4_Memory")).toThrow(/prefix/)
  })
  it("exposes the pattern it enforces", () => {
    expect(IDENTIFIER_PATTERN.source).toBe("^[a-z_][a-z0-9_]*$")
    expect(IDENTIFIER_PATTERN.flags).toBe("")
  })
})

describe("pgvectorMemoryStore", () => {
  it("validates dimensions at construction time", () => {
    expect(() => pgvectorMemoryStore({ dimensions: 4001 })).toThrow(/4000 halfvec index ceiling/)
  })
})
