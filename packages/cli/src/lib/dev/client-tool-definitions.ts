/**
 * Bounds and validates caller-authored client tool definitions (the `tools`
 * array of an AG-UI run envelope) for a route that opted in to client tools.
 *
 * AG-UI's ToolSchema puts no bound on name, description, or parameters, and
 * every byte of them becomes prompt content. The limits here cap context
 * budget and blast radius. They do NOT prevent prompt injection: a
 * well-formed, in-budget description can still carry hostile instructions.
 *
 * Depth: the top-level schema is level 1; each schema object nested under
 * `properties.<x>`, `items`, `additionalProperties` (when an object), or a
 * member of `anyOf`/`oneOf`/`allOf` adds one level. Up to
 * MAX_CLIENT_TOOL_DEPTH (8) levels are accepted (top + 7 nested), matching the
 * tool converter's MAX_ZOD_DEPTH, below which fields are silently degraded.
 * The converter also turns any non-`{type:"object", properties}` schema into a
 * permissive record, so a top-level `type` other than "object" is rejected.
 *
 * Pure and edge-safe (no node: imports).
 */
import { CLIENT_TOOL_PREFIX, type ClientToolDefinition } from "@b4run/core"

export const MAX_CLIENT_TOOLS = 32
export const MAX_CLIENT_TOOL_DESCRIPTION = 1024
export const MAX_CLIENT_TOOL_PARAMETERS = 8192
export const MAX_CLIENT_TOOL_DEPTH = 8
export const MAX_CLIENT_TOOL_BLOCK = 32 * 1024

export type ClientToolRejectionCode =
  | "invalid_client_tool"
  | "invalid_client_tool_name"
  | "duplicate_client_tool"
  | "client_tool_too_large"
  | "client_tool_too_deep"
  | "client_tool_budget_exceeded"

export type ReadClientToolsResult =
  | { readonly ok: true; readonly tools: readonly ClientToolDefinition[] }
  | {
      readonly ok: false
      readonly code: ClientToolRejectionCode
      readonly message: string
      readonly status: 422
    }

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

function reject(code: ClientToolRejectionCode, message: string): ReadClientToolsResult {
  return { ok: false, code, message, status: 422 }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** True when the schema nests deeper than `limit` levels; stops early. */
function exceedsDepth(schema: unknown, level: number, limit: number): boolean {
  if (!isPlainObject(schema)) return false
  if (level > limit) return true
  const children: unknown[] = []
  const props = schema.properties
  if (isPlainObject(props)) children.push(...Object.values(props))
  children.push(schema.items)
  if (isPlainObject(schema.additionalProperties)) children.push(schema.additionalProperties)
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const members = schema[key]
    if (Array.isArray(members)) children.push(...members)
  }
  for (const child of children) {
    if (exceedsDepth(child, level + 1, limit)) return true
  }
  return false
}

export function readClientToolDefinitions(tools: unknown): ReadClientToolsResult {
  if (!Array.isArray(tools)) {
    return reject("invalid_client_tool", "tools must be an array")
  }
  if (tools.length > MAX_CLIENT_TOOLS) {
    return reject(
      "client_tool_budget_exceeded",
      `at most ${MAX_CLIENT_TOOLS} client tools are allowed per run`,
    )
  }

  const seen = new Set<string>()
  const out: ClientToolDefinition[] = []
  let total = 0

  for (const entry of tools) {
    if (!isPlainObject(entry) || typeof entry.name !== "string") {
      return reject("invalid_client_tool", "each client tool must be an object with a string name")
    }
    const name = entry.name
    if (!NAME_PATTERN.test(name) || name.startsWith(CLIENT_TOOL_PREFIX)) {
      return reject(
        "invalid_client_tool_name",
        `client tool names must match ${NAME_PATTERN.source} and must not start with "${CLIENT_TOOL_PREFIX}"`,
      )
    }
    if (seen.has(name)) {
      return reject("duplicate_client_tool", `client tool "${name}" is declared more than once`)
    }
    seen.add(name)

    const description = entry.description ?? ""
    if (typeof description !== "string") {
      return reject("invalid_client_tool", `client tool "${name}" description must be a string`)
    }
    if (description.length > MAX_CLIENT_TOOL_DESCRIPTION) {
      return reject(
        "client_tool_too_large",
        `client tool "${name}" description exceeds ${MAX_CLIENT_TOOL_DESCRIPTION} characters`,
      )
    }

    const parameters = entry.parameters ?? { type: "object", properties: {} }
    if (!isPlainObject(parameters)) {
      return reject("invalid_client_tool", `client tool "${name}" parameters must be an object`)
    }
    if (parameters.type !== undefined && parameters.type !== "object") {
      return reject(
        "invalid_client_tool",
        `client tool "${name}" parameters must be an object schema`,
      )
    }
    let serialized: string
    try {
      serialized = JSON.stringify(parameters)
    } catch {
      return reject("invalid_client_tool", `client tool "${name}" parameters must be JSON`)
    }
    if (serialized.length > MAX_CLIENT_TOOL_PARAMETERS) {
      return reject(
        "client_tool_too_large",
        `client tool "${name}" parameters exceed ${MAX_CLIENT_TOOL_PARAMETERS} characters`,
      )
    }
    if (exceedsDepth(parameters, 1, MAX_CLIENT_TOOL_DEPTH)) {
      return reject(
        "client_tool_too_deep",
        `client tool "${name}" parameters nest deeper than ${MAX_CLIENT_TOOL_DEPTH} levels`,
      )
    }

    total += name.length + description.length + serialized.length
    if (total > MAX_CLIENT_TOOL_BLOCK) {
      return reject(
        "client_tool_budget_exceeded",
        `client tool definitions exceed ${MAX_CLIENT_TOOL_BLOCK} characters in total`,
      )
    }

    out.push({ name, description, parameters })
  }

  return { ok: true, tools: out }
}
