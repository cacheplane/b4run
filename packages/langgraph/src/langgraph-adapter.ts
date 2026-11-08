import { type BackendAdapter, CooperativeStopError } from "@b4run/sdk"

async function retirePendingActions(
  entry: object,
  config: Record<string, unknown>,
  native: typeof import("@langchain/langgraph"),
  input?: unknown,
) {
  if (input instanceof native.Command || !("getState" in entry)) return
  if ("checkpointer" in entry && !entry.checkpointer) return
  const graph = entry as {
    config?: Record<string, unknown>
    getState(
      config: Record<string, unknown>,
    ): Promise<{ next?: readonly string[]; tasks?: readonly { interrupts?: readonly unknown[] }[] }>
    updateState(config: Record<string, unknown>, value: null, asNode: string): Promise<unknown>
  }
  config = {
    ...graph.config,
    ...config,
    configurable: {
      ...(graph.config?.configurable as Record<string, unknown> | undefined),
      ...(config.configurable as Record<string, unknown> | undefined),
    },
  }
  const snapshot = await graph.getState(config)
  if (!snapshot.next?.length) return
  if (snapshot.tasks?.some((task) => task.interrupts?.length))
    throw new Error("A parked graph requires an authorized resume")
  if (!(entry instanceof native.CompiledStateGraph) || typeof graph.updateState !== "function")
    throw new Error("Cannot safely retire pending graph actions")
  await graph.updateState(config, null, native.END)
  if ((await graph.getState(config)).next?.length)
    throw new Error("Pending graph actions could not be retired safely")
}

export function createLangGraphAdapter(kind: "graph" | "workflow"): BackendAdapter {
  return {
    kind,
    protocol: { injection: false },

    async execute(
      entry: unknown,
      input: unknown,
      context: { readonly signal: AbortSignal; readonly stopSignal?: AbortSignal },
    ): Promise<unknown> {
      context.signal.throwIfAborted()
      if (context.stopSignal?.aborted) throw new CooperativeStopError()
      if (kind === "workflow") {
        if (typeof entry !== "function") {
          throw new Error("Workflow entry must be a function")
        }
        return await entry(input, context)
      }

      if (typeof entry === "function") {
        return await entry(input, context)
      }

      if (
        typeof entry === "object" &&
        entry !== null &&
        "invoke" in entry &&
        typeof (entry as { invoke?: unknown }).invoke === "function"
      ) {
        // Load the native peer only for graph control or checkpoint inspection.
        if (!context.stopSignal && !("getState" in entry))
          return await (entry as { invoke: (input: unknown, context: unknown) => unknown }).invoke(
            input,
            context,
          )
        const native = await import("@langchain/langgraph")
        const { RunControl, isGraphDrained } = native
        const control = context.stopSignal ? new RunControl() : undefined
        const request = () => control?.requestDrain("b4 Stop")
        context.stopSignal?.addEventListener("abort", request, { once: true })
        try {
          if (context.stopSignal?.aborted) throw new CooperativeStopError()
          if (input !== null || ("__b4_fresh_turn" in context && context.__b4_fresh_turn === true))
            await retirePendingActions(entry, context, native, input)
          return await (entry as { invoke: (input: unknown, context: unknown) => unknown }).invoke(
            input,
            { ...context, ...(control ? { control, durability: "sync" } : {}) },
          )
        } catch (error) {
          if (control?.drainRequested && isGraphDrained(error)) {
            await retirePendingActions(entry, context, native)
            throw new CooperativeStopError()
          }
          throw error
        } finally {
          context.stopSignal?.removeEventListener("abort", request)
        }
      }

      throw new Error("Graph entry must be a function or expose invoke(input)")
    },

    async *stream(
      entry: unknown,
      input: unknown,
      context: { readonly signal: AbortSignal; readonly stopSignal?: AbortSignal },
    ): AsyncIterable<unknown> {
      const result = await this.execute(entry, input, context)
      yield result
    },
  }
}

export const graphAdapter = createLangGraphAdapter("graph")
export const workflowAdapter = createLangGraphAdapter("workflow")
