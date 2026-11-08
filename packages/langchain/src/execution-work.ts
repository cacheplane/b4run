import type { ExecutionWork } from "@b4run/sdk/internal/execution-work"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"

export { ExecutionWork, trackGraphCompletion } from "@b4run/sdk/internal/execution-work"

/** Official BaseChatModel primitives live under optional RunnableBindings. */
export function trackModelPrimitives(model: unknown, work: ExecutionWork): unknown {
  const visited = new Set<object>()
  let current = model
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current)
    const primitive = current as Record<string, unknown>
    if (typeof primitive._generate === "function") {
      const generate = primitive._generate as (...args: unknown[]) => unknown
      primitive._generate = function (...args: unknown[]) {
        return work.run(() => generate.apply(this, args))
      }
      const baseStream = (BaseChatModel.prototype as unknown as Record<string, unknown>)
        ._streamResponseChunks
      // BaseChatModel uses method identity to detect actual streaming support.
      // Wrapping its unimplemented default would change model behavior.
      if (
        typeof primitive._streamResponseChunks === "function" &&
        primitive._streamResponseChunks !== baseStream
      ) {
        const stream = primitive._streamResponseChunks as (
          ...args: unknown[]
        ) => AsyncIterable<unknown>
        primitive._streamResponseChunks = function (...args: unknown[]) {
          return work.stream(stream.apply(this, args))
        }
      }
      return model
    }
    current = primitive.bound
  }
  throw Object.assign(new Error("The model does not expose supported primitive unwind hooks"), {
    code: "not_supported",
  })
}

export function trackToolPrimitive<T extends object>(tool: T, work: ExecutionWork): T {
  const primitive = tool as Record<string, unknown>
  if (typeof primitive.func !== "function")
    throw Object.assign(new Error("The tool does not expose its primitive callback"), {
      code: "not_supported",
    })
  const run = primitive.func as (...args: unknown[]) => unknown
  primitive.func = function (...args: unknown[]) {
    return work.run(() => run.apply(this, args))
  }
  return tool
}
