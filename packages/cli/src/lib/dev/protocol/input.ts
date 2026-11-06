import type { B4Message, B4RunWaitResponse } from "@b4run/sdk/agent-protocol"
import { mergePublicMessages, parsePublicMessages, toPublicMessage } from "./messages.js"

export interface ProtocolOutputOptions {
  /** Declare message output: true projects top-level messages; false normalizes
   * them inside values. Omitted leaves opaque graph business state untouched. */
  readonly messages?: boolean
  /** A declared stateful adapter must return its public state object. */
  readonly stateful?: boolean
}

/** Trusted, resolved adapter contract, supplied by the binding, never from a
 * caller's JSON flags. Graph business input is opaque unless messages are
 * explicitly declared here. parseInput is the route's schema parser/guard. */
export interface ProtocolBoundaryOptions {
  readonly messages?: readonly B4Message[]
  readonly adapter: {
    readonly parseInput: (input: unknown) => unknown
    readonly messages?: {
      readonly reduce: (
        left: readonly B4Message[],
        right: readonly B4Message[],
      ) => readonly B4Message[]
      /** Required for explicit non-object input combined with messages. */
      readonly combineInput?: (input: unknown, messages: readonly B4Message[]) => unknown
    }
  }
  readonly output?: ProtocolOutputOptions
}

export function normalizeProtocolInput(input: unknown, options: ProtocolBoundaryOptions): unknown {
  try {
    const capability = options.adapter.messages
    if (options.messages !== undefined && !capability) {
      throw new Error("adapter does not declare messages input")
    }
    let candidate = input
    if (
      capability &&
      (options.messages !== undefined || (isRecord(input) && Object.hasOwn(input, "messages")))
    ) {
      const top = options.messages === undefined ? [] : parsePublicMessages(options.messages)
      const nested =
        isRecord(input) && Object.hasOwn(input, "messages")
          ? parsePublicMessages(input.messages)
          : []
      // Check conflicts before the adapter's reducer can replace/discard an ID.
      mergePublicMessages(top, nested)
      const messages = parsePublicMessages(capability.reduce(top, nested))
      if (isRecord(input) || input === undefined) {
        candidate = { ...(input ?? {}), messages }
      } else if (capability.combineInput) {
        candidate = capability.combineInput(input, messages)
      } else {
        throw new Error("adapter cannot combine non-object input with messages")
      }
    }
    return options.adapter.parseInput(candidate)
  } catch (error) {
    throw new Error(
      `Route input validation error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Shape a route result for standard resources without touching native callers. */
export function normalizeProtocolOutput(
  output: unknown,
  options: ProtocolOutputOptions = {},
): B4RunWaitResponse {
  if (!isRecord(output)) {
    if (options.stateful) throw new Error("Protocol adapter must return a public state object")
    // JSON has no undefined value: represent an absent route return explicitly
    // as null so serialization cannot silently omit the output field.
    return { values: { output: output === undefined ? null : output } }
  }
  if (options.messages !== undefined && Object.hasOwn(output, "messages")) {
    if (!Array.isArray(output.messages))
      throw new Error("Invalid output messages: expected an array")
    const messages = mergePublicMessages([], output.messages.map(toPublicMessage))
    const { messages: _duplicate, ...values } = output
    return options.messages ? { values, messages } : { values: { ...values, messages } }
  }
  return { values: output }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
