import type { ExecutionWork } from "./execution-work.js"

const handlers = new WeakMap<object, ExecutionWork>()
const installed = new WeakMap<object, ReadonlyMap<string, Function>>()

/** Runtime callback plumbing only. Identity is private; copying a name or JSON
 * object cannot enroll a primitive in another invocation's completion set. */
export function executionCallback(work: ExecutionWork): object {
  const marker = {
    name: "B4ActualExecutionWork",
    awaitHandlers: true,
    copy() {
      return marker
    },
    toJSON() {
      return { lc: 1, type: "not_implemented", id: ["B4ActualExecutionWork"] }
    },
  }
  handlers.set(marker, work)
  return marker
}
function workFor(manager: unknown): ExecutionWork | undefined {
  const entries = (manager as { handlers?: unknown } | undefined)?.handlers
  if (!Array.isArray(entries)) return undefined
  // A nested adapter appends its own marker after inherited callbacks. Its
  // parent tracks the composite call; the child drains only its own primitives.
  for (let index = entries.length - 1; index >= 0; index--) {
    const value = entries[index]
    if (value && typeof value === "object") {
      const work = handlers.get(value)
      if (work) return work
    }
  }
  return undefined
}
export function withExecutionCallback(config: unknown, marker: object): Record<string, unknown> {
  const value = (config ?? {}) as Record<string, unknown>
  const original = value.callbacks
  let callbacks: unknown
  if (original === undefined) callbacks = [marker]
  else if (Array.isArray(original)) callbacks = [...original, marker]
  else if (
    original &&
    typeof original === "object" &&
    typeof (original as { copy?: unknown }).copy === "function"
  ) {
    const copied = (
      original as { copy(): { addHandler?(handler: object, inherit: boolean): void } }
    ).copy()
    if (typeof copied.addHandler !== "function")
      throw Object.assign(new Error("Unsupported callback manager"), { code: "not_supported" })
    copied.addHandler(marker, true)
    callbacks = copied
  } else throw Object.assign(new Error("Unsupported callback manager"), { code: "not_supported" })
  return { ...value, callbacks }
}

/** Prepare every descriptor before installing transparent instance hooks.
 * Original receivers, provider clients and stateful model counters survive. */
export function primitiveHookPlan(value: object, kind: "model" | "tool"): (() => void) | undefined {
  const object = value as Record<string, unknown>
  let base: object | undefined
  for (
    let prototype = Object.getPrototypeOf(value);
    prototype;
    prototype = Object.getPrototypeOf(prototype)
  )
    if (prototype.constructor?.name === (kind === "model" ? "BaseChatModel" : "StructuredTool")) {
      base = prototype
      break
    }
  if (!base) return undefined
  const existing = installed.get(value)
  if (existing) {
    if ([...existing].some(([key, method]) => object[key] !== method))
      throw Object.assign(new Error("Primitive completion hook was replaced"), {
        code: "not_supported",
      })
    return () => {}
  }
  const keys = kind === "model" ? ["_generate", "_streamResponseChunks"] : ["_call"]
  const descriptors: PropertyDescriptorMap = {},
    wrappers = new Map<string, Function>()
  for (const key of keys) {
    const original = object[key]
    if (typeof original !== "function")
      throw Object.assign(new Error("Unsupported primitive completion shape"), {
        code: "not_supported",
      })
    if (key === "_streamResponseChunks" && original === (base as Record<string, unknown>)[key])
      continue
    const own = Object.getOwnPropertyDescriptor(value, key)
    if (own ? !("value" in own) || own.writable !== true : !Object.isExtensible(value))
      throw Object.assign(new Error("Primitive completion hook is not writable"), {
        code: "not_supported",
      })
    const method = function (this: unknown, ...args: unknown[]) {
      const work = workFor(args[kind === "model" ? 2 : 1])
      if (!work) return original.apply(this, args)
      if (key === "_streamResponseChunks")
        return work.stream(original.apply(this, args) as AsyncIterable<unknown>)
      return work.run(async () => {
        const result: unknown = await original.apply(this, args)
        return result && typeof result === "object" && Symbol.asyncIterator in result
          ? work.stream(result as AsyncIterable<unknown>)
          : result
      })
    }
    wrappers.set(key, method)
    descriptors[key] = {
      ...(own ?? { configurable: true, writable: true, enumerable: false }),
      value: method,
    }
  }
  return () => {
    Object.defineProperties(value, descriptors)
    installed.set(value, wrappers)
  }
}
