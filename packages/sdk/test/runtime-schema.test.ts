import { describe, expect, it } from "vitest"
import {
  decodeRecoveryIdentityTuple,
  encodeRecoveryIdentityTuple,
  recoverySchemaStatements,
  recoveryTables,
  runtimeExpressionsEqual,
} from "../src/internal/runtime-schema.ts"

describe("source-owned recovery schema", () => {
  it("keeps all12 additive tables/10 indexes and108 checks for each backend", () => {
    expect(recoveryTables).toHaveLength(12)
    expect(recoveryTables.flatMap((t) => t.indexes)).toHaveLength(10)
    for (const backend of ["sqlite", "postgres"] as const) {
      const sql = recoverySchemaStatements(backend, {
        schema: "r9_v1",
        prefix: "p".repeat(38),
      }).join("\n")
      expect(sql.match(/\bCHECK\(/g)).toHaveLength(108)
      expect(sql).not.toContain("'namespace_json'")
      expect(sql).toContain("'namespace'")
      expect(sql).not.toMatch(/\b(?:IN|BETWEEN|jsonb_typeof|json_typeof)\b/)
      expect(sql).not.toContain("::jsonb")
    }
  })
  it("retains exact escaped identity bytes and refuses noncanonical representations", () => {
    const tuple = ["", "\0", "\\u0000", "\ud800", "\udc00", "\ufffd", "😀", "é", "é", "a/b", '"\\']
    const encoded = asciiJsonV1(tuple)
    expect(encoded).toMatch(/^[\x20-\x7e]*$/)
    expect(parseAsciiJsonV1(encoded)).toEqual(tuple)
    expect(
      decodeRecoveryIdentityTuple(
        encodeRecoveryIdentityTuple([1, "t", "g", tuple, "namespace", null]),
      ),
    ).toEqual([1, "t", "g", tuple, "namespace", null])
    expect(asciiJsonV1(["\0"])).not.toEqual(asciiJsonV1(["\\u0000"]))
    expect(() => decodeRecoveryIdentityTuple('[ "x" ]')).toThrow()
    expect(() => decodeRecoveryIdentityTuple("[1]")).toThrow()
  })
  it("keeps ordered typed expression semantics and narrow strict bounds", () => {
    const context = {
      relation: "s.p_recovery_versions",
      columnTypes: { previous_version_seq: "int8", version_seq: "int8", source_seq: "int8" },
      strictLessThan: { left: "previous_version_seq", right: "version_seq" },
    } as const
    expect(
      runtimeExpressionsEqual(
        "previous_version_seq IS NULL OR previous_version_seq<version_seq",
        "((previous_version_seq IS NULL) OR (previous_version_seq < version_seq))",
        context,
      ),
    ).toBe(true)
    for (const near of [
      "previous_version_seq<=version_seq",
      "version_seq>previous_version_seq",
      "source_seq<version_seq",
      "previous_version_seq OPERATOR(public.<) version_seq",
    ])
      expect(runtimeExpressionsEqual("previous_version_seq<version_seq", near, context)).toBe(false)
    expect(
      runtimeExpressionsEqual("source_seq<=version_seq", "version_seq>=source_seq", context),
    ).toBe(false)
  })
  it("preserves legacy JSON keys and permits only approved literal casts", () => {
    const context = {
      relation: "s.p_receipts",
      columnTypes: { payload: "text" },
      legacy: true,
    } as const
    expect(
      runtimeExpressionsEqual(
        "(payload::jsonb)->'operation'->>'scopeKey'",
        "(((payload)::jsonb -> 'operation'::text) ->> 'scopeKey'::text)",
        context,
      ),
    ).toBe(true)
    expect(
      runtimeExpressionsEqual(
        "payload::jsonb->>'scopeKey'",
        "payload::jsonb->>'scopekey'",
        context,
      ),
    ).toBe(false)
    expect(
      runtimeExpressionsEqual(
        "payload::jsonb->>'scopeKey'",
        "payload::public.jsonb->>'scopeKey'",
        context,
      ),
    ).toBe(false)
  })
})

import {
  asciiJsonV1,
  parseAsciiJsonV1,
  parseRuntimeExpression,
  recoveryChecks,
  recoveryColumnSources,
  recoveryColumnType,
} from "../src/internal/runtime-schema.ts"

it("enumerates every generated PG CHECK through the closed typed constructors", () => {
  let count = 0
  for (const table of recoveryTables) {
    const relation = `r9_v1.b4_ap_v1_${table.name}`
    const columnTypes = Object.fromEntries(
      recoveryColumnSources(table).map((column) => [
        column.split(" ")[0],
        recoveryColumnType(column),
      ]),
    )
    const strictLessThan =
      table.name === "recovery_versions"
        ? { left: "previous_version_seq", right: "version_seq" }
        : table.name === "recovery_cuts"
          ? { left: "previous_cut_seq", right: "through_seq" }
          : undefined
    const context = { relation, columnTypes, ...(strictLessThan ? { strictLessThan } : {}) }
    for (const check of recoveryChecks(table, "postgres")) {
      expect(parseRuntimeExpression(check, context).type).toBe("bool")
      expect(runtimeExpressionsEqual(check, `(${check})`, context)).toBe(true)
      expect(runtimeExpressionsEqual(check, `${check} OR true`, context)).toBe(false)
      count++
    }
  }
  expect(count).toBe(108)
})
it("stores JSON values/member order without changing wire number or string policy", () => {
  const value = {
    z: "\0",
    toJSON: "ordinary JSON member",
    a: [1, null, true, "\\u0000", "\ud800", "😀"],
  }
  const source = asciiJsonV1(value)
  expect(source.startsWith('{"z":')).toBe(true)
  expect(parseAsciiJsonV1(source)).toEqual(value)
  expect(() => parseAsciiJsonV1('["é"]')).toThrow()
  expect(() => parseAsciiJsonV1('["\\u0061"]')).toThrow()
  expect(() =>
    asciiJsonV1({
      get unsafe(): never {
        throw new Error("getter called")
      },
    }),
  ).toThrow("Unsupported recovery JSON")
})
it("never indexes arbitrary public identities in the new schema", () => {
  const bounded = new Set([
    "scope_key",
    "entity_key",
    "object_id",
    "identity_hash",
    "scope_hash",
    "branch_id",
    "fragment_id",
    "checkpoint_key",
    "item_key",
    "entity_kind",
    "version_seq",
    "through_seq",
    "source_seq",
    "commit_seq",
    "fragment_index",
    "checkpoint_fragment_index",
    "link_seq",
    "is_open",
    "singleton",
  ])
  for (const table of recoveryTables) {
    for (const columns of [
      table.primaryKey,
      ...table.unique,
      ...table.indexes.map((index) => index.columns),
    ])
      for (const column of columns)
        expect(bounded.has(column.replace(/ DESC$/, "")), `${table.name}.${column}`).toBe(true)
  }
})

it("retains exact scope/entity identity distinctions without indexed public text", () => {
  const longId = "é".repeat(65_537)
  const tuple = [1, "thread", "generation", [longId, "a/b", ""], "message", longId] as const
  expect(decodeRecoveryIdentityTuple(encodeRecoveryIdentityTuple(tuple))).toEqual(tuple)
  const distinct = [
    [1, "thread", "generation", ["a/b"], "message", "id"],
    [1, "thread", "generation", ["a", "b"], "message", "id"],
    [1, "thread", "generation", ["a/b"], "activity", "id"],
  ] as const
  expect(new Set(distinct.map(encodeRecoveryIdentityTuple)).size).toBe(3)
})
it("admits only the other exact strict-cut context and source literal types", () => {
  const context = {
    relation: "s.p_recovery_cuts",
    columnTypes: { previous_cut_seq: "int8", through_seq: "int8" },
    strictLessThan: { left: "previous_cut_seq", right: "through_seq" },
  } as const
  expect(
    runtimeExpressionsEqual(
      "previous_cut_seq<through_seq",
      "((previous_cut_seq) < (through_seq))",
      context,
    ),
  ).toBe(true)
  expect(
    runtimeExpressionsEqual(
      "previous_cut_seq<through_seq",
      "previous_cut_seq<=through_seq",
      context,
    ),
  ).toBe(false)
  expect(
    runtimeExpressionsEqual("previous_cut_seq<through_seq", "previous_cut_seq<through_seq", {
      ...context,
      relation: "s.p_journal",
    }),
  ).toBe(false)
  expect(
    runtimeExpressionsEqual("previous_cut_seq<through_seq", "previous_cut_seq<through_seq", {
      ...context,
      columnTypes: { previous_cut_seq: "int4", through_seq: "int8" },
    }),
  ).toBe(false)
  expect(
    runtimeExpressionsEqual(
      "through_seq<=9007199254740991",
      "through_seq<='9007199254740991'::pg_catalog.int8",
      context,
    ),
  ).toBe(true)
  expect(
    runtimeExpressionsEqual(
      "through_seq<=9007199254740991",
      "through_seq<='9007199254740991'::pg_catalog.numeric",
      context,
    ),
  ).toBe(false)
})

// Canonical JSON syntax does not make an entity-kind value a literal string.
it("rejects canonical non-string entity kinds in both identity entry points", () => {
  const invalidKinds: readonly import("../src/internal/runtime-schema.ts").RecoveryJsonValue[] = [
    ["message"],
    ["activity"],
    ["pending"],
    ["namespace"],
    {},
    { literal: "message" },
    0,
    1,
    true,
    false,
    null,
  ]
  for (const kind of invalidKinds) {
    const value = [1, "t", "g", [], kind, "id"] as const
    const canonical = asciiJsonV1(value)
    expect(parseAsciiJsonV1(canonical)).toEqual(value)
    expect(() => decodeRecoveryIdentityTuple(canonical)).toThrow("Invalid recovery identity tuple")
    // Deliberately exercise malformed runtime input crossing the static type boundary.
    expect(() =>
      encodeRecoveryIdentityTuple(
        value as unknown as import("../src/internal/runtime-schema.ts").RecoveryIdentityTuple,
      ),
    ).toThrow("Invalid recovery identity tuple")
  }
})
it("round-trips every exact literal entity kind with its required identity shape", () => {
  const kinds = [
    "thread",
    "run",
    "turn",
    "pending",
    "activity",
    "message",
    "namespace",
    "maintenance",
    "checkpoint",
  ] as const
  for (const kind of kinds) {
    const id =
      kind === "namespace"
        ? null
        : kind === "pending"
          ? (["owner", "paused", "interrupt", "proposal"] as const)
          : "id"
    const value = [1, "t", "g", [], kind, id] as const
    const canonical = asciiJsonV1(value)
    expect(encodeRecoveryIdentityTuple(value)).toBe(canonical)
    expect(decodeRecoveryIdentityTuple(canonical)).toEqual(value)
  }
})
