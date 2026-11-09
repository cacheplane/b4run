import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Ajv2020 } from "ajv/dist/2020.js"
import { fullFormats } from "ajv-formats/dist/formats.js"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"
import { AgentCatalogError } from "../src/lib/dev/protocol/catalog.ts"
import {
  ProtocolError,
  protocolAspError,
  protocolErrorResponse,
  protocolRestError,
} from "../src/lib/dev/protocol/errors.ts"

it("serializes only trusted bounded execution loss diagnostics and keeps ordinary storage failures unchanged", async () => {
  const failure = new ProtocolError("storage_unavailable", { executionLost: true })
  const diagnostic = {
    v: 1,
    code: "storage_unavailable",
    reason: "execution_lost",
    effectsUncertain: true,
  }
  expect(protocolRestError(failure)).toEqual({
    code: "storage_unavailable",
    message: "Storage unavailable",
    metadata: { b4: diagnostic },
  })
  expect(protocolAspError(failure, 7)).toEqual({
    type: "error",
    id: 7,
    error: "unknown_error",
    message: "Storage unavailable",
    meta: { b4: diagnostic },
  })
  expect(validates("B4ErrorResponse", protocolRestError(failure))).toBe(true)
  expect(validates("AspErrorResponse", protocolAspError(failure, 7))).toBe(true)
  const response = protocolErrorResponse(failure)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual(protocolRestError(failure))
  expect(protocolRestError(new ProtocolError("storage_unavailable"))).toEqual({
    code: "storage_unavailable",
    message: "Storage unavailable",
  })
  expect(
    protocolRestError(
      new ProtocolError("storage_unavailable", { executionLost: false as unknown as true }),
    ),
  ).toEqual({ code: "storage_unavailable", message: "Storage unavailable" })
  expect(protocolRestError(new ProtocolError("not_found", { executionLost: true }))).toEqual({
    code: "not_found",
    message: "Resource not found",
  })
  const untrusted = Object.assign(new Error("SECRET"), {
    code: "storage_unavailable",
    options: { executionLost: true, ownerId: "SECRET" },
    metadata: { b4: diagnostic },
  })
  expect(protocolRestError(untrusted)).toEqual({
    code: "internal_error",
    message: "Internal server error",
  })
  expect(protocolAspError(untrusted, 7).meta?.b4).toEqual({ v: 1, code: "internal_error" })
  const trustedOptions = {
    executionLost: true as const,
    ownerId: "SECRET",
    grant: "SECRET",
    reason: "SECRET",
  }
  expect(
    protocolRestError(new ProtocolError("storage_unavailable", trustedOptions)).metadata?.b4,
  ).toEqual(diagnostic)
  expect(
    JSON.stringify(protocolAspError(new ProtocolError("storage_unavailable", trustedOptions), 1)),
  ).not.toContain("SECRET")
})

import {
  matchesLiteralFilters,
  parseCallerMetadata,
  parseRunSearchMetadata,
  validateProtocolConfig,
} from "../src/lib/dev/protocol/metadata.ts"
import {
  parseProtocolJson,
  parseProtocolRequest,
  requireProtocolControl,
} from "../src/lib/dev/protocol/validate.ts"

const id = "00000000-0000-0000-0000-000000000001"
const schema = JSON.parse(
  readFileSync(new URL("../../sdk/dist/agent-protocol.schema.json", import.meta.url), "utf8"),
)
const ajv = new Ajv2020({ strict: false, formats: fullFormats })
ajv.addSchema({ ...schema, $id: "urn:b4:cli:c5" })
const validates = (name: string, value: unknown) =>
  ajv.validate({ $ref: `urn:b4:cli:c5#/$defs/${name}` }, value)

const errors = [
  ["workspace_not_found", 404, "no_such_run"],
  ["workspace_lost", 404, "no_such_run"],
  ["workspace_expired", 410, "invalid_argument"],
  ["workspace_not_ready", 409, "invalid_argument"],
  ["workspace_conflict", 409, "invalid_argument"],
  ["workspace_changed", 409, "invalid_argument"],
  ["workspace_unavailable", 503, "unknown_error"],
  ["workspace_root_missing", 422, "invalid_argument"],
  ["workspace_inspection_refused", 422, "invalid_argument"],
  ["workspace_read_timeout", 504, "unknown_error"],
  ["workspace_response_too_large", 422, "invalid_argument"],
  ["invalid_request", 400, "invalid_argument"],
  ["digest_mismatch", 400, "invalid_argument"],
  ["workspace_source_invalid", 422, "invalid_argument"],
  ["staged_quota_exceeded", 507, "unknown_error"],
  ["workspace_uploader_invalid", 422, "invalid_argument"],
  ["upload_timeout", 408, "invalid_argument"],
  ["malformed_json", 400, "invalid_argument"],
  ["invalid_argument", 422, "invalid_argument"],
  ["auth_required", 401, "permission_denied"],
  ["not_found", 404, "no_such_run"],
  ["thread_exists", 409, "invalid_argument"],
  ["thread_busy", 409, "invalid_argument"],
  ["stale_generation", 409, "invalid_argument"],
  ["incomplete_responses", 422, "invalid_argument"],
  ["grant_invalid", 403, "permission_denied"],
  ["grant_expired", 403, "permission_denied"],
  ["approval_changed", 409, "invalid_argument"],
  ["not_supported", 422, "not_supported"],
  ["resync_required", 409, "invalid_argument"],
  ["history_changed", 409, "invalid_argument"],
  ["history_expired", 410, "invalid_argument"],
  ["result_expired", 410, "invalid_argument"],
  ["submission_conflict", 409, "invalid_argument"],
  ["receipt_expired", 409, "invalid_argument"],
  ["capacity_exceeded", 429, "invalid_argument"],
  ["storage_unavailable", 503, "unknown_error"],
  ["submission_ambiguous", 409, "invalid_argument"],
  ["submission_target_gone", 409, "invalid_argument"],
  ["submission_already_accepted", 409, "invalid_argument"],
  ["agent_required", 422, "invalid_argument"],
  ["item_changed", 409, "invalid_argument"],
  ["precondition_failed", 412, "invalid_argument"],
  ["body_too_large", 413, "invalid_argument"],
  ["durable_capacity_exceeded", 507, "unknown_error"],
] as const

describe("shared protocol errors", () => {
  it.each(errors)("maps %s to REST %s and legal ASP %s", async (code, status, asp) => {
    const error = new ProtocolError(code)
    const response = protocolErrorResponse(error)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual(protocolRestError(error))
    expect(protocolRestError(error)).toMatchObject({ code, message: expect.any(String) })
    expect(protocolRestError(error)).not.toHaveProperty("error")
    const frame = protocolAspError(error, 7)
    expect(frame).toMatchObject({ type: "error", id: 7, error: asp, meta: { b4: { v: 1, code } } })
    expect(validates("AspErrorResponse", frame)).toBe(true)
    expect(response.headers.get("Retry-After")).toBe(code === "capacity_exceeded" ? "1" : null)
  })
  it("uses safe resource-specific absence/stale-answer codes", () => {
    for (const [resource, error] of [
      ["checkpoint", "no_such_checkpoint"],
      ["input", "no_such_interrupt"],
      ["namespace", "no_such_namespace"],
      ["thread", "permission_denied"],
    ] as const) {
      expect(protocolAspError(new ProtocolError("not_found", { resource }), 1).error).toBe(error)
    }
    expect(
      protocolAspError(new ProtocolError("stale_generation", { resource: "input" }), 1).error,
    ).toBe("no_such_interrupt")
  })
  it("sanitizes unknown runtime and protected catalog errors", () => {
    for (const error of [
      new Error("SECRET grant private checkpoint"),
      { code: "grant_invalid", message: "SECRET", stack: "SECRET", metadata: { grant: "SECRET" } },
    ]) {
      expect(protocolRestError(error)).toEqual({
        code: "internal_error",
        message: "Internal server error",
      })
      expect(JSON.stringify(protocolAspError(error, null))).not.toContain("SECRET")
      expect(protocolAspError(error, null)).not.toHaveProperty("stacktrace")
    }
    expect(
      protocolRestError(new AgentCatalogError("not_found", 404, "SECRET denied route")),
    ).toEqual({ code: "not_found", message: "Resource not found" })
    expect(
      protocolRestError(new AgentCatalogError("agent_required", 422, "SECRET default")),
    ).toMatchObject({ code: "agent_required" })
  })
  it("does not reflect parser errors, values, grants or arbitrary diagnostic fields", () => {
    expect(() => parseProtocolJson("{SECRET")).toThrow(ProtocolError)
    try {
      parseProtocolJson("{SECRET")
    } catch (e) {
      expect(JSON.stringify(protocolRestError(e))).not.toContain("SECRET")
    }
    expect(
      protocolErrorResponse(new ProtocolError("capacity_exceeded", { retryAfter: 3 })).headers.get(
        "Retry-After",
      ),
    ).toBe("3")
  })
})

const restCases: readonly (readonly [string, string, unknown, boolean])[] = [
  ["run", "B4RunStream", {}, true],
  [
    "run",
    "B4RunStream",
    { input: { route: "data", resume: true, b4: { arbitrary: true } }, future: [1] },
    true,
  ],
  ...["values", [], ["messages", "custom"]].map(
    (stream_mode) => ["run", "B4RunStream", { stream_mode }, true] as const,
  ),
  ...[null, 1, ["bad"], "bad"].map(
    (stream_mode) => ["run", "B4RunStream", { stream_mode }, false] as const,
  ),
  [
    "run",
    "B4RunStream",
    { thread_id: id, on_disconnect: "continue", on_completion: "delete", if_not_exists: "create" },
    true,
  ],
  ["run", "B4RunStream", { thread_id: id.toUpperCase().replace("00000000", "AAAAAAAA") }, false],
  ["run", "B4RunStream", { route: "retired" }, false],
  ["run", "B4RunStream", { resume: {} }, false],
  [
    "run",
    "B4RunStream",
    { config: { tags: ["a"], recursion_limit: -1, configurable: { locale: "en" }, future: true } },
    true,
  ],
  ["run", "B4RunStream", { config: { tags: "bad" } }, false],
  ["thread.create", "B4ThreadCreate", { thread_id: id, if_exists: "do_nothing", future: 1 }, true],
  ["thread.create", "B4ThreadCreate", { metadata: { b4: { v: 1 } } }, false],
  [
    "thread.patch",
    "B4ThreadPatch",
    { checkpoint: { checkpoint_id: id }, values: { route: "data" }, future: 1 },
    true,
  ],
  [
    "thread.patch",
    "B4ThreadPatch",
    { messages: [{ role: "user", content: [{ type: "future", opaque: [1] }] }] },
    true,
  ],
  [
    "run.search",
    "B4RunSearchRequest",
    { metadata: { "b4.submissionId": id, "b4.submissionKind": "b4", business: 1 } },
    true,
  ],
  [
    "run.search",
    "B4RunSearchRequest",
    { metadata: { "b4.submissionId": "native-token", "b4.submissionKind": "agui" } },
    true,
  ],
  [
    "run.search",
    "B4RunSearchRequest",
    { metadata: { "b4.submissionId": "bad", "b4.submissionKind": "b4" } },
    false,
  ],
  ["run.search", "B4RunSearchRequest", { metadata: { "b4.targetRunId": id } }, false],
  ["run.search", "B4RunSearchRequest", { limit: 1001 }, false],
  ["thread.search", "ThreadSearchRequest", { limit: 0 }, false],
  [
    "agent.search",
    "AgentSearchRequest",
    { name: "a", metadata: { "b4.submissionId": "ordinary" } },
    true,
  ],
  ["history", "B4ThreadHistoryQuery", { limit: -1, before: "opaque" }, true],
  ["history", "B4ThreadHistoryQuery", { limit: 1001 }, false],
  ["cancel", "RunCancelQuery", { action: "rollback", wait: true, future: 1 }, true],
  ["cancel", "RunCancelQuery", { wait: "false" }, false],
  [
    "namespaces",
    "StoreListNamespacesRequest",
    { prefix: ["a"], suffix: [], limit: 0, offset: 0, max_depth: -1, future: 1 },
    true,
  ],
] as const

describe("request parsers agree with exact C2 schemas", () => {
  it.each(restCases)("REST %s %#", (kind, name, value, valid) => {
    expect(validates(name as string, value)).toBe(valid)
    if (valid)
      expect(() =>
        parseProtocolRequest(kind as never, value, { config: { allowedKeys: ["locale"] } }),
      ).not.toThrow()
    else
      expect(() =>
        parseProtocolRequest(kind as never, value, { config: { allowedKeys: ["locale"] } }),
      ).toThrow(ProtocolError)
  })
  it("resolves defaults while preserving supplied scalar/array and annotations", () => {
    expect(parseProtocolRequest("run", {})).toEqual({
      on_disconnect: "cancel",
      on_completion: "delete",
      if_not_exists: "reject",
      stream_mode: "values",
    })
    expect(
      parseProtocolRequest("run", {
        thread_id: id,
        stream_mode: ["values"],
        on_disconnect: "continue",
      }),
    ).toMatchObject({ on_completion: "keep", stream_mode: ["values"], on_disconnect: "continue" })
    expect(parseProtocolRequest("thread.create", {})).toEqual({ if_exists: "raise" })
    expect(parseProtocolRequest("cancel", {})).toEqual({ action: "interrupt", wait: false })
    for (const kind of ["agent.search", "thread.search", "run.search"] as const)
      expect(parseProtocolRequest(kind, {})).toEqual({ limit: 10, offset: 0 })
    expect(parseProtocolRequest("history", {})).toEqual({ limit: 10 })
    expect(parseProtocolRequest("namespaces", {})).toEqual({ limit: 100, offset: 0 })
  })
})

const commandCases = [
  [
    {
      id: 1,
      method: "run.start",
      params: { assistantId: "/a#graph", input: { route: "data", resume: true } },
    },
    true,
  ],
  [
    { id: 1, method: "run.start", params: { assistantId: "/a#graph", input: null, future: 1 } },
    false,
  ],
  [{ id: 1, method: "run.start", params: { input: null } }, false],
  [
    {
      id: 1,
      method: "input.respond",
      params: { namespace: [], interruptId: "opaque", response: { business: true } },
    },
    true,
  ],
  [
    {
      id: 1,
      method: "input.respond",
      params: { responses: [{ namespace: [], interruptId: "opaque", response: 1, metadata: {} }] },
    },
    false,
  ],
  [{ id: 1, method: "input.respond", params: { responses: [] } }, false],
  [
    {
      id: 1,
      method: "input.inject",
      params: {
        namespace: [],
        message: { role: "system", content: "a", future: true, b4: { v: 1, submissionId: id } },
      },
    },
    true,
  ],
  [
    {
      id: 1,
      method: "input.inject",
      params: { namespace: [], message: { role: "assistant", content: "a" } },
    },
    false,
  ],
  [
    {
      id: 1,
      method: "state.fork",
      b4: { v: 1 },
      future: 1,
      params: { checkpointId: id, input: [1] },
    },
    true,
  ],
  [
    { id: 1, method: "state.fork", params: { checkpointId: id, metadata: { b4: { v: 1 } } } },
    false,
  ],
  [{ id: 1, method: "state.get", params: { namespace: [], keys: ["a"], future: 1 } }, false],
  [{ id: 1, method: "state.listCheckpoints", params: { limit: 0, before: "opaque" } }, true],
  [{ id: 1, method: "agent.getTree", params: { runId: id } }, true],
  [
    { id: 1, method: "subscription.subscribe", params: { channels: ["custom:future"], future: 1 } },
    true,
  ],
  [{ id: 1, method: "subscription.subscribe", params: { channels: [] } }, false],
  [
    { id: 1, method: "subscription.unsubscribe", params: { subscriptionId: "opaque", future: 1 } },
    true,
  ],
  [
    {
      id: 1,
      method: "subscription.reconnect",
      params: { runId: id, lastEventId: "opaque", subscriptions: [], future: 1 },
    },
    true,
  ],
  [{ id: -1, method: "state.get", params: { namespace: [] } }, false],
] as const

describe("ASP closed maps and carrier-specific submission metadata", () => {
  it.each(commandCases)("command %#", (value, valid) => {
    expect(validates("B4Command", value)).toBe(valid)
    if (valid) expect(() => parseProtocolRequest("command", value)).not.toThrow()
    else expect(() => parseProtocolRequest("command", value)).toThrow(ProtocolError)
  })
  it("reports unknown commands and unsupported controls explicitly", () => {
    expect(
      protocolAspError(
        caught(() => parseProtocolRequest("command", { id: 1, method: "old.resume", params: {} })),
        1,
      ).error,
    ).toBe("unknown_command")
    expect(() => requireProtocolControl("rollback", false)).toThrow(ProtocolError)
    expect(() => requireProtocolControl("rollback", true)).not.toThrow()
  })
})
function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error("Expected rejection")
}

describe("additional protected carrier boundaries", () => {
  it.each([{ limit: -1 }, { offset: -1 }])(
    "applies the approved Store pagination policy %#",
    (value) => {
      // Upstream has no bound here; approved Store §5 supplies this B4 policy.
      expect(validates("StoreListNamespacesRequest", value)).toBe(true)
      expect(() => parseProtocolRequest("namespaces", value)).toThrow(ProtocolError)
    },
  )
  it("keeps public diagnostics to a fixed capability vocabulary", () => {
    const options = { feature: "rollback" as const }
    const error = new ProtocolError("not_supported", options)
    Object.assign(options, { feature: "SECRET grant" })
    expect(protocolAspError(error, 1)).toMatchObject({ meta: { b4: { feature: "rollback" } } })
    const forged = new ProtocolError("not_supported", { feature: "SECRET grant" as never })
    expect(JSON.stringify(protocolRestError(forged))).not.toContain("SECRET")
    expect(JSON.stringify(protocolAspError(forged, 1))).not.toContain("SECRET")
  })
  it("does not serialize even a trusted error's mutated runtime message", () => {
    const error = new ProtocolError("invalid_argument")
    error.message = "SECRET runtime exception"
    expect(protocolRestError(error).message).toBe("Invalid request")
    expect(protocolAspError(error, 1).message).toBe("Invalid request")
  })
  it.each([
    { sourceDigest: "a".repeat(64), future: true },
    {
      sourceDigest: "a".repeat(64),
      environmentLinks: [{ path: "x", target: "y", uploadedBy: "forged" }],
    },
  ])("preserves closed workspace references %#", (workspace) => {
    const value = { workspace }
    expect(validates("B4ThreadCreate", value)).toBe(false)
    expect(() => parseProtocolRequest("thread.create", value)).toThrow(ProtocolError)
  })
  it.each(["run", "thread.create", "thread.patch"] as const)(
    "rejects misplaced B4 carriers on %s",
    (kind) => {
      expect(() => parseProtocolRequest(kind, { b4: { v: 1, submissionId: id } })).toThrow(
        ProtocolError,
      )
    },
  )
  it.each([null, [], "body", 1, true])("rejects non-object request envelopes %#", (value) => {
    for (const kind of [
      "run",
      "thread.create",
      "thread.patch",
      "run.search",
      "thread.search",
      "agent.search",
      "history",
      "cancel",
      "namespaces",
      "command",
    ] as const)
      expect(() => parseProtocolRequest(kind, value)).toThrow(ProtocolError)
  })
})

describe("metadata and configuration authority boundaries", () => {
  it.each([
    { b4: { v: 2 } },
    { b4: { v: 1, turnId: id } },
    { b4: { v: 1, submissionId: "native-token" } },
    { b4: { v: 1, expected: { namespace: [] } } },
    { "b4.submissionId": id },
  ])("rejects forged Run metadata %#", (value) => {
    expect(() => parseCallerMetadata(value, "run")).toThrow(ProtocolError)
  })
  it("preserves annotations and defined request-only B4 fields", () => {
    const value = {
      business: { route: "ordinary" },
      b4: { v: 1, submissionId: id, expected: { runId: id } },
    }
    expect(parseCallerMetadata(value, "run")).toEqual(value)
    expect(parseCallerMetadata({ route: "annotation" }, "thread")).toEqual({ route: "annotation" })
  })
  it("keeps ordinary literal equality separate from receipt selectors", () => {
    expect(matchesLiteralFilters({ a: { x: 1, y: 2 }, "a.x": 3 }, { "a.x": 3 })).toBe(true)
    expect(matchesLiteralFilters({ a: { x: 1 } }, { "a.x": 1 })).toBe(false)
    expect(matchesLiteralFilters({ a: { x: 1, y: 2 } }, { a: { x: 1 } })).toBe(false)
    expect(matchesLiteralFilters({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true)
    expect(parseRunSearchMetadata({ b4: { submissionId: id } })).toEqual({
      filters: { b4: { submissionId: id } },
    })
    expect(
      parseRunSearchMetadata({ "b4.submissionId": id, "b4.submissionKind": "b4", business: 1 }),
    ).toEqual({ filters: { business: 1 }, lookup: { submissionId: id, submissionKind: "b4" } })
    expect(
      parseProtocolRequest("thread.search", { metadata: { "b4.submissionId": "literal" } }),
    ).toMatchObject({ metadata: { "b4.submissionId": "literal" } })
  })
  it.each([
    "thread_id",
    "run_id",
    "checkpoint_id",
    "checkpoint_ns",
    "principal",
    "namespace",
    "owner",
    "fence",
    "permissions",
    "grant",
    "store",
    "sandbox",
  ])("rejects protected config %s even if whitelisted", (key) => {
    expect(() =>
      validateProtocolConfig({ configurable: { [key]: "forged" } }, { allowedKeys: [key] }),
    ).toThrow(ProtocolError)
    expect(() => validateProtocolConfig({ [key]: "forged" }, { allowedKeys: [key] })).toThrow(
      ProtocolError,
    )
  })
  it("requires a resolved route guard/whitelist for configurable options", () => {
    expect(() => validateProtocolConfig({ configurable: { locale: "en" } })).toThrow(ProtocolError)
    expect(
      validateProtocolConfig(
        { tags: ["trace"], configurable: { locale: "en" } },
        { allowedKeys: ["locale"], parse: (value) => value },
      ),
    ).toEqual({ tags: ["trace"], configurable: { locale: "en" } })
    expect(() =>
      validateProtocolConfig({ configurable: { unknown: 1 } }, { allowedKeys: [] }),
    ).toThrow(ProtocolError)
  })
})

// Compare boundary strings against the independent, published C2 schema. Do not
// replace URI syntax with WHATWG normalization or tighten CDDL regex matching.
describe("review regressions for pinned string constraints", () => {
  const channelCases = (
    JSON.parse(
      readFileSync(
        new URL("../../../test/agent-protocol/fixtures/b4-wire-cases.json", import.meta.url),
        "utf8",
      ),
    ) as { name: string; schema: string; value: unknown; valid: boolean }[]
  ).filter((wire) => wire.schema === "AspChannel")
  it.each(channelCases)("matches $name", ({ value: channel, valid }) => {
    const value = { id: 1, method: "subscription.subscribe", params: { channels: [channel] } }
    expect(validates("AspChannel", channel)).toBe(valid)
    expect(validates("B4Command", value)).toBe(valid)
    if (valid) expect(parseProtocolRequest("command", value)).toEqual(value)
    else expect(() => parseProtocolRequest("command", value)).toThrow(ProtocolError)
  })
  it.each([
    ["https://example.com/a b", false],
    ["https://example.com/a\nb", false],
    ["https://example.com/a\rb", false],
    ["https://example.com/a\tb", false],
    ["https://example.com/a\n", false],
    ["https://example.com/\u0000", false],
    ["https://example.com/a\\b", false],
    ["https://example.com/%", false],
    ["https://example.com/%2", false],
    ["https://example.com/%GG", false],
    ["https://example.com/a%20b", true],
    ["HTTP://EXAMPLE.COM:80", true],
    ["https://example.com", true],
    ["urn:example:animal:ferret:nose", true],
    ["mailto:a@example.com", true],
    ["https://example.com/?x=%2F#frag", true],
  ] as const)("validates the original webhook URI %j", (webhook, valid) => {
    const value = { webhook }
    expect(validates("B4RunStream", value)).toBe(valid)
    if (valid) expect(parseProtocolRequest("run", value).webhook).toBe(webhook)
    else expect(() => parseProtocolRequest("run", value)).toThrow(ProtocolError)
  })
})

describe("protocol URI matcher runtime graph", () => {
  it("bundles for browsers without importing Ajv engine, codegen or Node", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("../src/lib/dev/protocol/validate.ts", import.meta.url))],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    })
    if (!result.metafile) throw new Error("Missing protocol bundle metafile")
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.some((file) => /ajv-formats.*\/dist\/formats.js$/.test(file))).toBe(true)
    expect(inputs.filter((file) => /\/ajv\/dist\//.test(file))).toEqual([])
    expect(
      Object.values(result.metafile.inputs)
        .flatMap((input) => input.imports)
        .filter((item) => item.path.startsWith("node:")),
    ).toEqual([])
    for (const output of result.outputFiles)
      expect(output.text).not.toMatch(/\bnew Function\b|\beval\s*\(/)
  })
})
