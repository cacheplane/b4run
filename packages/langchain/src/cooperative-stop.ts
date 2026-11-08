import { CooperativeStopError } from "@b4run/sdk"
import { Command, CompiledStateGraph, END, isGraphDrained, RunControl } from "@langchain/langgraph"

/** One native control per invocation; never reuse a drained control. */
export function cooperativeControl(stopSignal?: AbortSignal) {
  const control = new RunControl()
  const request = () => control.requestDrain("b4 Stop")
  if (stopSignal?.aborted) throw new CooperativeStopError()
  stopSignal?.addEventListener("abort", request, { once: true })
  return {
    control,
    release: () => stopSignal?.removeEventListener("abort", request),
    stopped: (error: unknown) => control.drainRequested && isGraphDrained(error),
  }
}

const ownedGraphs = new WeakSet<object>()

/** Register only graphs constructed by this adapter from supported createAgent. */
export function registerCooperativeGraph(graph: object): void {
  ownedGraphs.add(graph)
}

interface StatefulGraph {
  getState(
    config: Record<string, unknown>,
  ): Promise<{ next?: readonly string[]; tasks?: readonly { interrupts?: readonly unknown[] }[] }>
  updateState(config: Record<string, unknown>, values: null, asNode: string): Promise<unknown>
}

/**
 * A fresh user turn cannot resume a previous turn's scheduled actions. The
 * public END update retires tasks without executing them; history is retained.
 * A permission park belongs to its explicit Command resume and is never retired.
 */
export async function retirePendingActions(
  entry: unknown,
  config: Record<string, unknown>,
  input?: unknown,
): Promise<void> {
  if (input instanceof Command) return
  if (typeof entry !== "object" || entry === null || !("getState" in entry)) return
  if ("checkpointer" in entry && !entry.checkpointer) return
  const graph = entry as StatefulGraph
  if (typeof graph.getState !== "function") return
  const defaults = (entry as { config?: Record<string, unknown> }).config
  config = {
    ...defaults,
    ...config,
    configurable: {
      ...(defaults?.configurable as Record<string, unknown> | undefined),
      ...(config.configurable as Record<string, unknown> | undefined),
    },
  }
  const snapshot = await graph.getState(config)
  if (!snapshot.next?.length) return
  if (snapshot.tasks?.some((task) => task.interrupts?.length)) {
    throw new Error("A parked graph requires an authorized resume")
  }
  if (
    (!(entry instanceof CompiledStateGraph) && !ownedGraphs.has(entry)) ||
    typeof graph.updateState !== "function"
  )
    throw new Error("Cannot safely retire pending graph actions")
  await graph.updateState(config, null, END)
  if ((await graph.getState(config)).next?.length)
    throw new Error("Pending graph actions could not be retired safely")
}
