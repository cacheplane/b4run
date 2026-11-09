import type {
  AgentSearchRequest,
  B4Command,
  B4RunSearchRequest,
  B4RunStream,
  B4ThreadCreate,
  B4ThreadHistoryQuery,
  B4ThreadPatch,
  RunCancelQuery,
  StoreListNamespacesRequest,
  ThreadSearchRequest,
} from "@b4run/sdk/agent-protocol"
import { fullFormats } from "ajv-formats/dist/formats.js"
import { ProtocolError, type ProtocolErrorOptions } from "./errors.js"
import { parsePublicMessages } from "./messages.js"
import {
  canonicalProtocolId,
  invalid,
  type ProtocolConfigPolicy,
  parseCallerMetadata,
  parseRequestMetadata,
  parseRunSearchMetadata,
  protocolRecord,
  validateProtocolConfig,
} from "./metadata.js"

export interface ProtocolRequests {
  readonly run: B4RunStream
  readonly "thread.create": B4ThreadCreate
  readonly "thread.patch": B4ThreadPatch
  readonly "agent.search": AgentSearchRequest
  readonly "thread.search": ThreadSearchRequest
  readonly "run.search": B4RunSearchRequest
  readonly history: B4ThreadHistoryQuery
  readonly cancel: RunCancelQuery
  readonly namespaces: StoreListNamespacesRequest
  readonly command: B4Command
}
export interface ProtocolValidationOptions {
  readonly config?: ProtocolConfigPolicy
}
export function parseProtocolJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ProtocolError("malformed_json")
  }
}
export function requireProtocolControl(
  feature: NonNullable<ProtocolErrorOptions["feature"]>,
  supported: boolean,
): void {
  if (!supported) throw new ProtocolError("not_supported", { feature })
}
/** Wire shape and defaults only: no row lookup, receipt acceptance or mutation.
 * The binding supplies any resolved route config policy; omitted means no
 * caller-controlled route config. Unknown standard annotations remain intact. */
export function parseProtocolRequest<K extends keyof ProtocolRequests>(
  kind: K,
  value: unknown,
  options: ProtocolValidationOptions = {},
): ProtocolRequests[K] {
  const record = { ...protocolRecord(value) }
  if (kind === "command") return parseCommand(record, options) as ProtocolRequests[K]
  if (
    (kind === "run" || kind === "thread.create" || kind === "thread.patch") &&
    Object.hasOwn(record, "b4")
  )
    invalid()
  if (kind === "run" || kind === "thread.create") {
    if (Object.hasOwn(record, "route") || Object.hasOwn(record, "resume")) invalid()
    optional(record, "thread_id", canonicalProtocolId)
  }
  if (kind === "run" || kind === "thread.patch")
    optional(record, "messages", (value) => {
      try {
        parsePublicMessages(value)
      } catch {
        invalid()
      }
    })
  if (kind === "run") {
    optional(record, "agent_id", text)
    optional(record, "metadata", (value) => parseCallerMetadata(value, "run"))
    optional(record, "config", (value) => validateProtocolConfig(value, options.config))
    optional(record, "webhook", (value) => {
      if (typeof value !== "string" || value.length < 1 || value.length > 65536) invalid()
      // The exact pinned URI format validates the original bytes. WHATWG URL
      // parsing would normalize whitespace, escapes and controls first.
      if (typeof fullFormats.uri !== "function" || !fullFormats.uri(value)) invalid()
    })
    optional(record, "on_disconnect", (value) => oneOf(value, ["cancel", "continue"]))
    optional(record, "on_completion", (value) => oneOf(value, ["delete", "keep"]))
    optional(record, "if_not_exists", (value) => oneOf(value, ["create", "reject"]))
    optional(record, "stream_mode", (value) => {
      const modes = Array.isArray(value) ? value : [value]
      for (const mode of modes) oneOf(mode, ["values", "messages", "updates", "custom"])
    })
    record.on_disconnect ??= "cancel"
    record.on_completion ??= Object.hasOwn(record, "thread_id") ? "keep" : "delete"
    record.if_not_exists ??= "reject"
    record.stream_mode ??= "values"
  } else if (kind === "thread.create" || kind === "thread.patch") {
    optional(record, "metadata", (value) => parseCallerMetadata(value, "thread"))
    if (kind === "thread.create") {
      optional(record, "if_exists", (value) => oneOf(value, ["raise", "do_nothing"]))
      optional(record, "workspace", workspace)
      record.if_exists ??= "raise"
    } else {
      optional(record, "values", protocolRecord)
      optional(record, "checkpoint", (value) => {
        const checkpoint = protocolRecord(value)
        canonicalProtocolId(checkpoint.checkpoint_id)
      })
    }
  } else if (kind === "agent.search" || kind === "thread.search" || kind === "run.search") {
    optional(record, "metadata", kind === "run.search" ? parseRunSearchMetadata : protocolRecord)
    optional(record, "limit", (value) => integer(value, 1, 1000))
    optional(record, "offset", (value) => integer(value, 0))
    if (kind === "agent.search") optional(record, "name", text)
    if (kind === "thread.search") {
      optional(record, "values", protocolRecord)
      optional(record, "status", (value) => oneOf(value, ["idle", "busy", "interrupted", "error"]))
    }
    if (kind === "run.search") {
      optional(record, "thread_id", canonicalProtocolId)
      optional(record, "agent_id", text)
      optional(record, "status", (value) =>
        oneOf(value, ["pending", "success", "interrupted", "timeout", "error"]),
      )
    }
    record.limit ??= 10
    record.offset ??= 0
  } else if (kind === "history") {
    optional(record, "limit", (value) => integer(value, undefined, 1000))
    optional(record, "before", text)
    record.limit ??= 10
  } else if (kind === "cancel") {
    optional(record, "action", (value) => oneOf(value, ["interrupt", "rollback"]))
    optional(record, "wait", (value) => {
      if (typeof value !== "boolean") invalid()
    })
    record.action ??= "interrupt"
    record.wait ??= false
  } else if (kind === "namespaces") {
    optional(record, "prefix", strings)
    optional(record, "suffix", strings)
    // Approved Store §5 bounds, not the Agent search 1–1000 bound.
    for (const key of ["limit", "offset"]) optional(record, key, (value) => integer(value, 0))
    optional(record, "max_depth", integer)
    record.limit ??= 100
    record.offset ??= 0
  }
  return record as ProtocolRequests[K]
}
function optional(
  record: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => unknown,
): void {
  if (Object.hasOwn(record, key)) parse(record[key])
}
function text(value: unknown): void {
  if (typeof value !== "string") invalid()
}
function strings(value: unknown): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid()
}
function integer(value: unknown, min?: number, max?: number): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    (min !== undefined && value < min) ||
    (max !== undefined && value > max)
  )
    invalid()
}
function oneOf(value: unknown, values: readonly string[]): void {
  if (typeof value !== "string" || !values.includes(value)) invalid()
}
function closed(
  record: Record<string, unknown>,
  keys: readonly string[],
  required: readonly string[] = [],
): void {
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  )
    invalid()
}
function workspace(value: unknown): void {
  const record = protocolRecord(value)
  closed(record, ["sourceDigest", "environmentLinks", "baseline"], ["sourceDigest"])
  text(record.sourceDigest)
  if (!/^[0-9a-f]{64}$/.test(record.sourceDigest as string) || Object.hasOwn(record, "uploadedBy"))
    invalid()
  optional(record, "baseline", (value) => oneOf(value, ["git"]))
  optional(record, "environmentLinks", (value) => {
    if (!Array.isArray(value)) invalid()
    for (const item of value) {
      const link = protocolRecord(item)
      closed(link, ["path", "target"], ["path", "target"])
      text(link.path)
      text(link.target)
    }
  })
}
function parseCommand(
  record: Record<string, unknown>,
  options: ProtocolValidationOptions,
): B4Command {
  integer(record.id, 0, Number.MAX_SAFE_INTEGER)
  text(record.method)
  const params = protocolRecord(record.params)
  const method = record.method
  if (method !== "state.fork" && Object.hasOwn(record, "b4")) invalid()
  if (method === "run.start") {
    closed(
      params,
      ["assistantId", "input", "config", "metadata", "langsmithTracer"],
      ["assistantId", "input"],
    )
    text(params.assistantId)
    optional(params, "metadata", (value) => parseCallerMetadata(value, "run"))
    optional(params, "config", (value) => validateProtocolConfig(value, options.config, "asp"))
    optional(params, "langsmithTracer", (value) => {
      const tracer = protocolRecord(value)
      closed(tracer, ["projectName", "exampleId"])
      optional(tracer, "projectName", text)
      optional(tracer, "exampleId", text)
    })
  } else if (method === "input.respond") {
    if (Object.hasOwn(params, "responses")) {
      closed(params, ["responses", "update", "goto", "config", "metadata"], ["responses"])
      if (!Array.isArray(params.responses) || params.responses.length === 0) invalid()
      for (const item of params.responses) responseEntry(protocolRecord(item))
    } else {
      closed(
        params,
        ["namespace", "interruptId", "response", "update", "goto", "config", "metadata"],
        ["namespace", "interruptId", "response"],
      )
      strings(params.namespace)
      text(params.interruptId)
    }
    optional(params, "metadata", (value) => parseCallerMetadata(value, "run"))
    optional(params, "update", protocolRecord)
    optional(params, "goto", goto)
    optional(params, "config", (value) => validateProtocolConfig(value, options.config, "asp"))
  } else if (method === "input.inject") {
    closed(params, ["namespace", "message"], ["namespace", "message"])
    strings(params.namespace)
    const message = protocolRecord(params.message)
    oneOf(message.role, ["user", "system"])
    text(message.content)
    optional(message, "name", text)
    optional(message, "b4", parseRequestMetadata)
  } else if (method === "state.get") {
    closed(params, ["namespace", "keys"], ["namespace"])
    strings(params.namespace)
    optional(params, "keys", strings)
  } else if (method === "state.listCheckpoints") {
    closed(params, ["namespace", "limit", "before"])
    optional(params, "namespace", strings)
    optional(params, "limit", (value) => integer(value, 0))
    optional(params, "before", text)
  } else if (method === "state.fork") {
    closed(params, ["checkpointId", "input", "config"], ["checkpointId"])
    canonicalProtocolId(params.checkpointId)
    optional(record, "b4", parseRequestMetadata)
    optional(params, "config", (value) => validateProtocolConfig(value, options.config, "asp"))
  } else if (method === "agent.getTree") {
    closed(params, ["runId"])
    optional(params, "runId", canonicalProtocolId)
  } else if (method === "subscription.subscribe") {
    if (!Array.isArray(params.channels) || params.channels.length === 0) invalid()
    for (const channel of params.channels) {
      if (
        typeof channel !== "string" ||
        (![
          "values",
          "updates",
          "messages",
          "tools",
          "lifecycle",
          "input",
          "checkpoints",
          "tasks",
          "custom",
        ].includes(channel) &&
          !/^(?:custom:[^\n\r]+)$/u.test(channel))
      )
        invalid()
    }
    optional(params, "namespaces", (value) => {
      if (!Array.isArray(value)) invalid()
      for (const ns of value) strings(ns)
    })
    optional(params, "depth", (value) => integer(value, 0))
  } else if (method === "subscription.unsubscribe") {
    text(params.subscriptionId)
  } else if (method === "subscription.reconnect") {
    canonicalProtocolId(params.runId)
    optional(params, "lastEventId", text)
    optional(params, "subscriptions", strings)
  } else throw new ProtocolError("unknown_command")
  return record as B4Command
}
function responseEntry(record: Record<string, unknown>): void {
  closed(record, ["namespace", "interruptId", "response"], ["namespace", "interruptId", "response"])
  strings(record.namespace)
  text(record.interruptId)
}
function goto(value: unknown): void {
  for (const target of Array.isArray(value) ? value : [value]) {
    if (typeof target === "string") continue
    const send = protocolRecord(target)
    closed(send, ["node", "input"], ["node"])
    text(send.node)
  }
}
