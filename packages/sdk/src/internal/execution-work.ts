import { executionCallback, primitiveHookPlan, withExecutionCallback } from "./model-work.js"

/** Tracks actual primitive completion before LangChain's outer abort races.
 * Invocation-local; this is not an execution owner or a cancellation signal. */
export class ExecutionWork {
  private readonly pending = new Set<Promise<unknown>>()
  private readonly iterators = new Set<AsyncIterator<unknown>>()
  private closing = false
  private draining: Promise<void> | undefined

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    const forget = () => this.pending.delete(promise)
    promise.then(forget, forget)
    return promise
  }
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error("Execution has stopped accepting primitive work"))
    try {
      return this.track(Promise.resolve(operation()))
    } catch (error) {
      return this.track(Promise.reject(error))
    }
  }
  stream<T>(source: AsyncIterable<T>): AsyncIterableIterator<T> {
    const iterator = source[Symbol.asyncIterator]()
    this.iterators.add(iterator)
    const next = async (): Promise<IteratorResult<T>> => {
      const value = await this.run(() => iterator.next())
      if (value.done) this.iterators.delete(iterator)
      return value
    }
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next,
      return: async () => {
        try {
          return await this.track(
            Promise.resolve(iterator.return?.() ?? { done: true as const, value: undefined }),
          )
        } finally {
          this.iterators.delete(iterator)
        }
      },
    }
  }
  /** Attempt every iterator finalizer and await every already-issued primitive.
   * Operation rejections remain owned by their original model/tool handler;
   * cleanup errors are distinct and are never silently discarded. */
  drain(): Promise<void> {
    if (this.draining) return this.draining
    this.closing = true
    this.draining = (async () => {
      const cleanupErrors: unknown[] = []
      while (this.pending.size || this.iterators.size) {
        const iterators = [...this.iterators]
        for (const iterator of iterators) this.iterators.delete(iterator)
        const cleanup = iterators.map((iterator) =>
          Promise.resolve().then(() => iterator.return?.()),
        )
        const results = await Promise.allSettled([...this.pending, ...cleanup])
        for (const result of results.slice(results.length - cleanup.length))
          if (result.status === "rejected") cleanupErrors.push(result.reason)
      }
      if (cleanupErrors.length)
        throw new AggregateError(cleanupErrors, "Primitive stream finalization failed")
    })()
    return this.draining
  }
}

/** Preserve the original graph error while attempting both owned drains. */
export async function drainExecution(
  work: ExecutionWork,
  writes?: () => Promise<void>,
): Promise<void> {
  const errors: unknown[] = []
  // A raw primitive can cause its final task writes only AFTER it settles.
  // Starting the write drain beside it would observe an empty write set.
  try {
    await work.drain()
  } catch (error) {
    errors.push(error)
  }
  try {
    await writes?.()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length) throw new AggregateError(errors, "Execution finalization failed")
}

export function trackGraphCompletion<T extends object>(
  graph: T,
  work: ExecutionWork,
  writes?: () => Promise<void>,
  ownedSaver?: unknown,
  callback?: object,
): T {
  const target = graph as Record<string, unknown>
  const ownedConfig = (value: unknown) => {
    const config = value as { configurable?: Record<string, unknown> } | undefined
    return ownedSaver && config?.configurable?.__pregel_checkpointer
      ? { ...config, configurable: { ...config.configurable, __pregel_checkpointer: ownedSaver } }
      : value
  }
  const finalize = async (primary: unknown) => {
    try {
      await drainExecution(work, writes)
    } catch (error) {
      if (primary !== undefined)
        throw new AggregateError([primary, error], "Execution and finalization failed", {
          cause: primary,
        })
      throw error
    }
  }
  const invoke = target.invoke as (...args: unknown[]) => Promise<unknown>
  target.invoke = async function (...args: unknown[]) {
    args[1] = ownedConfig(args[1])
    if (callback) args[1] = withExecutionCallback(args[1], callback)
    let primary: unknown
    try {
      return await invoke.apply(this, args)
    } catch (error) {
      primary = error
      throw error
    } finally {
      await finalize(primary)
    }
  }
  for (const name of ["stream", "streamEvents"]) {
    if (typeof target[name] !== "function") continue
    const stream = target[name] as (
      ...args: unknown[]
    ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
    target[name] = async function* (...args: unknown[]) {
      let primary: unknown
      args[1] = ownedConfig(args[1])
      if (callback) args[1] = withExecutionCallback(args[1], callback)
      const controller = new AbortController()
      const config = args[1] as { signal?: AbortSignal } | undefined
      args[1] = {
        ...config,
        signal: config?.signal
          ? AbortSignal.any([config.signal, controller.signal])
          : controller.signal,
      }
      let iterator: AsyncIterator<unknown> | undefined
      let finished = false
      try {
        const source = await stream.apply(this, args)
        iterator = source[Symbol.asyncIterator]()
        while (true) {
          const result = await iterator.next()
          if (result.done) {
            finished = true
            break
          }
          yield result.value
        }
      } catch (error) {
        primary = error
        throw error
      } finally {
        // Pinned LangGraph's outer readable-stream return does not await its
        // producer. Abort our invocation and keep consuming that producer to
        // completion before draining raw primitives and their final writes.
        if (!finished) {
          const closed = new Error("stream consumer closed")
          controller.abort(closed)
          try {
            if (iterator)
              while (!(await iterator.next()).done) {
                /* drain owned events */
              }
          } catch (error) {
            if (error !== closed && primary === undefined) primary = error
          }
        }
        await finalize(primary)
        if (primary !== undefined && !finished) {
          // biome-ignore lint/correctness/noUnsafeFinally: Consumer closure must propagate the original producer failure after all owned drains.
          throw primary
        }
      }
    }
  }
  return graph
}

/** Invocation-local copies of known runnable shapes preserve private brands.
 * Shared model/tool instances receive only transparent stable primitive hooks;
 * each invocation has its own callback identity and completion tracker. */
export function ownRunnableExecution<T extends object>(
  entry: T,
): { readonly entry: T; readonly work: ExecutionWork } {
  const work = new ExecutionWork(),
    copies = new Map<object, object>(),
    plans: (() => void)[] = []
  let active = false
  const install = () => {
    for (const plan of plans.splice(0)) plan()
  }
  const unsupported = (): never => {
    throw Object.assign(
      new Error("Runnable does not expose supported primitive completion hooks"),
      { code: "not_supported" },
    )
  }
  const primitive = (func: (...args: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]) {
      return work.run(async () => {
        const output = await func.apply(this, args)
        if (output && typeof output === "object" && Symbol.asyncIterator in output)
          return work.stream(output as AsyncIterable<unknown>)
        if (
          output &&
          typeof output === "object" &&
          (output as { lc_runnable?: unknown }).lc_runnable === true
        ) {
          const copied = clone(output)
          if (active) install()
          return copied
        }
        return output
      })
    }
  const clone = (value: object): object => {
    const prior = copies.get(value)
    if (prior) return prior
    const fields = value as Record<string, unknown>
    const type = value.constructor.name
    const Ctor = value.constructor as new (...args: unknown[]) => Record<string, unknown>
    const child = (input: unknown) => {
      if (!input || typeof input !== "object") return unsupported()
      return clone(input)
    }
    let copy: Record<string, unknown>
    if (
      ["CompiledStateGraph", "CompiledGraph", "Pregel"].includes(type) &&
      fields.lg_is_pregel === true &&
      typeof fields.withConfig === "function" &&
      fields.nodes &&
      typeof fields.nodes === "object"
    ) {
      copy = (fields.withConfig as (config: object) => Record<string, unknown>).call(value, {})
      if (copy === value || copy.constructor !== value.constructor) return unsupported()
      copies.set(value, copy)
      copy.nodes = Object.fromEntries(
        Object.entries(fields.nodes).map(([name, node]) => [name, child(node)]),
      )
    } else if (
      type === "PregelNode" &&
      fields.lc_graph_name === "PregelNode" &&
      Array.isArray(fields.writers)
    ) {
      copy = new Ctor({ ...fields, bound: child(fields.bound), writers: fields.writers.map(child) })
    } else if (type === "RunnableSequence" && Array.isArray(fields.middle)) {
      copy = new Ctor({
        ...fields,
        first: child(fields.first),
        middle: fields.middle.map(child),
        last: child(fields.last),
      })
    } else if (
      ["RunnableMap", "RunnableParallel"].includes(type) &&
      fields.steps &&
      typeof fields.steps === "object"
    ) {
      copy = new Ctor({
        ...fields,
        steps: Object.fromEntries(
          Object.entries(fields.steps).map(([name, step]) => [name, child(step)]),
        ),
      })
    } else if (type === "RunnableAssign") {
      copy = new Ctor({ ...fields, mapper: child(fields.mapper) })
    } else if (type === "RunnableEach") {
      copy = new Ctor({ ...fields, bound: child(fields.bound) })
    } else if (
      ["ChatPromptTemplate", "PromptTemplate"].includes(type) &&
      typeof fields.formatPromptValue === "function"
    ) {
      copy = new Ctor({ ...fields })
      copy.formatPromptValue = primitive(
        fields.formatPromptValue as (...args: unknown[]) => unknown,
      )
    } else if (
      ["StringOutputParser", "JsonOutputParser", "StructuredOutputParser"].includes(type) &&
      typeof fields.parseResult === "function"
    ) {
      copy = type === "StructuredOutputParser" ? new Ctor(fields.schema) : new Ctor({ ...fields })
      copy.parseResult = primitive(fields.parseResult as (...args: unknown[]) => unknown)
    } else if (
      Array.isArray(fields.lc_namespace) &&
      fields.lc_namespace[0] === "langchain" &&
      fields.lc_namespace[1] === "chat_models"
    ) {
      const plan = primitiveHookPlan(value, "model")
      if (!plan) return unsupported()
      plans.push(plan)
      copy = fields
    } else if (["DynamicTool", "DynamicStructuredTool"].includes(type)) {
      const plan = primitiveHookPlan(value, "tool")
      if (!plan) return unsupported()
      plans.push(plan)
      copy = fields
    } else if (type === "RunnableBinding") {
      copy = new Ctor({ ...fields, bound: child(fields.bound) })
    } else if (
      ["RunnableLambda", "RunnableCallable", "RunnablePassthrough"].includes(type) &&
      (typeof fields.func === "function" ||
        (type === "RunnablePassthrough" && fields.func === undefined))
    ) {
      copy = new Ctor({
        ...fields,
        ...(typeof fields.func === "function"
          ? { func: primitive(fields.func as (...args: unknown[]) => unknown) }
          : {}),
      })
    } else if (
      type === "ChannelWrite" &&
      Array.isArray(fields.writes) &&
      typeof fields.func === "function"
    ) {
      copy = new Ctor(fields.writes, fields.tags)
      copy.func = primitive(fields.func as (...args: unknown[]) => unknown)
    } else if (type === "ChannelRead" && typeof fields.func === "function") {
      copy = new Ctor(fields.channel, fields.mapper, fields.fresh)
      copy.func = primitive(fields.func as (...args: unknown[]) => unknown)
    } else if (
      fields.lc_runnable !== true &&
      fields.lg_is_pregel !== true &&
      typeof fields.invoke === "function"
    ) {
      // An authored invoker is itself the primitive. Keep its receiver (and
      // any private brand) intact instead of cloning an arbitrary class.
      const invoke = fields.invoke as (...args: unknown[]) => unknown
      copy = { invoke: (...args: unknown[]) => work.run(() => invoke.apply(value, args)) }
      if (typeof fields.stream === "function") {
        const stream = fields.stream as (
          ...args: unknown[]
        ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
        copy.stream = async (...args: unknown[]) => work.stream(await stream.apply(value, args))
      }
    } else return unsupported()
    copies.set(value, copy)
    return copy
  }
  const copied = clone(entry)
  install()
  active = true
  // A direct model/tool leaf stays on its original receiver. Its facade owns
  // invocation methods without replacing those methods on the shared entry.
  const overrides = new Map<PropertyKey, unknown>()
  const execution =
    copied === entry
      ? new Proxy(entry, {
          get(target, key) {
            if (overrides.has(key)) return overrides.get(key)
            const value: unknown = Reflect.get(target, key, target)
            return typeof value === "function" ? value.bind(target) : value
          },
          set(_target, key, value) {
            overrides.set(key, value)
            return true
          },
        })
      : copied
  return {
    entry: trackGraphCompletion(
      execution,
      work,
      undefined,
      undefined,
      executionCallback(work),
    ) as T,
    work,
  }
}
