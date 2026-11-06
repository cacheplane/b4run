import type { AspMessageRole, B4Message } from "@b4run/sdk/agent-protocol"

const publicRoles = new Set(["user", "assistant", "system", "tool"])
const constructorRoles: Readonly<Record<string, B4Message["role"]>> = {
  HumanMessage: "user",
  AIMessage: "assistant",
  SystemMessage: "system",
  ToolMessage: "tool",
}

/** Native message blocks and public extension fields remain opaque. Only the
 * message envelope is translated; business input never passes through here. */
export function toPublicMessage(value: unknown): B4Message {
  if (!isRecord(value)) throw new Error("Invalid message: expected an object")
  if (typeof value.getType === "function" && typeof value.toJSON === "function") {
    return toPublicMessage(value.toJSON())
  }
  if (value.lc === 1 && value.type === "constructor" && Array.isArray(value.id)) {
    const name: unknown = value.id.at(-1)
    const role = typeof name === "string" ? constructorRoles[name] : undefined
    if (!role || !isRecord(value.kwargs)) {
      throw new Error("Invalid message: unsupported native message constructor")
    }
    return parsePublicMessage({
      ...(unescapeNativeData(value.kwargs) as Record<string, unknown>),
      role,
    })
  }
  // LangGraph values may contain plain {type,content,...} message records.
  if (value.role === undefined && typeof value.type === "string") {
    const { type, ...fields } = value
    const role = type === "tool" ? "tool" : fromAspMessageRole(type)
    return parsePublicMessage({ ...fields, role })
  }
  return parsePublicMessage(value)
}

export function fromAspMessageRole(role: string): Exclude<B4Message["role"], "tool"> {
  switch (role) {
    case "human":
      return "user"
    case "ai":
      return "assistant"
    case "system":
      return "system"
    default:
      throw new Error(`Invalid ASP message role: ${role}`)
  }
}

export function toAspMessageRole(role: B4Message["role"]): AspMessageRole {
  switch (role) {
    case "user":
      return "human"
    case "assistant":
      return "ai"
    case "system":
      return "system"
    case "tool":
      throw new Error("Tool facts must use the ASP tools channel")
  }
}

/** REST input admits public roles only, never LangChain/ASP aliases. */
export function parsePublicMessages(value: unknown): readonly B4Message[] {
  if (!Array.isArray(value)) throw new Error("Invalid messages: expected an array")
  return mergePublicMessages([], value.map(parsePublicMessage))
}

export function mergePublicMessages(
  left: readonly B4Message[],
  right: readonly B4Message[],
): readonly B4Message[] {
  const result: B4Message[] = []
  const byId = new Map<string, B4Message>()
  for (const value of [...left, ...right]) {
    const message = parsePublicMessage(value)
    if (message.id !== undefined) {
      const previous = byId.get(message.id)
      if (previous) {
        if (!equivalentJson(previous, message)) {
          throw new Error(`Conflicting duplicate message ID: ${message.id}`)
        }
        continue
      }
      byId.set(message.id, message)
    }
    result.push(message)
  }
  return result
}

function parsePublicMessage(value: unknown): B4Message {
  if (!isRecord(value) || typeof value.role !== "string" || !publicRoles.has(value.role)) {
    throw new Error("Invalid message: expected a public user, assistant, system or tool role")
  }
  if (value.id !== undefined && typeof value.id !== "string") {
    throw new Error("Invalid message ID: expected a string")
  }
  // The pinned MessageAnyBlock branch permits every string type, including
  // "text" without a text field. Present block metadata still must be an object.
  if (
    typeof value.content !== "string" &&
    !(
      Array.isArray(value.content) &&
      value.content.every(
        (block) =>
          isRecord(block) &&
          typeof block.type === "string" &&
          (block.metadata === undefined || isRecord(block.metadata)),
      )
    )
  ) {
    throw new Error("Invalid message content: expected a string or native blocks")
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    throw new Error("Invalid message metadata: expected an object")
  }
  return value as B4Message
}

// LangChain escapes user objects with an `lc` key during serialization. Decode
// only inside a recognized message envelope, once; the wrapped data is opaque.
function unescapeNativeData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unescapeNativeData)
  if (!isRecord(value)) return value
  if (Object.keys(value).length === 1 && Object.hasOwn(value, "__lc_escaped__")) {
    return value.__lc_escaped__
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, unescapeNativeData(item)]),
  )
}

function equivalentJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, i) => equivalentJson(value, right[i]))
    )
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equivalentJson(left[key], right[key]))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
