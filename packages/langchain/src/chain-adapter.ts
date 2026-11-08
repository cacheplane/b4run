import { type BackendAdapter, CooperativeStopError } from "@b4run/sdk"

import { cooperativeControl, retirePendingActions } from "./cooperative-stop.js"

interface RunnableLike {
  readonly invoke: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  readonly stream: (
    input: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>
}

function assertRunnableLike(entry: unknown): asserts entry is RunnableLike {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("invoke" in entry) ||
    typeof (entry as { invoke?: unknown }).invoke !== "function"
  ) {
    throw new Error("Chain entry must expose invoke(input) — expected a LangChain Runnable")
  }
}

export const chainAdapter: BackendAdapter = {
  kind: "chain",

  async execute(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal; readonly stopSignal?: AbortSignal },
  ): Promise<unknown> {
    assertRunnableLike(entry)
    context.signal.throwIfAborted()
    const run = context.stopSignal ? cooperativeControl(context.stopSignal) : undefined
    try {
      if (input !== null || ("__b4_fresh_turn" in context && context.__b4_fresh_turn === true))
        await retirePendingActions(entry, context, input)
      return await entry.invoke(input, {
        ...context,
        ...(run ? { control: run.control, durability: "sync" } : {}),
      } as { signal: AbortSignal })
    } catch (error) {
      if (run?.stopped(error)) {
        await retirePendingActions(entry, context)
        throw new CooperativeStopError()
      }
      throw error
    } finally {
      run?.release()
    }
  },

  async *stream(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal; readonly stopSignal?: AbortSignal },
  ): AsyncIterable<unknown> {
    assertRunnableLike(entry)

    context.signal.throwIfAborted()
    const run = context.stopSignal ? cooperativeControl(context.stopSignal) : undefined
    try {
      if (input !== null || ("__b4_fresh_turn" in context && context.__b4_fresh_turn === true))
        await retirePendingActions(entry, context, input)
      if (typeof entry.stream !== "function") {
        yield await entry.invoke(input, {
          ...context,
          ...(run ? { control: run.control, durability: "sync" } : {}),
        } as { signal: AbortSignal })
        return
      }

      const streamResult = entry.stream(input, {
        ...context,
        ...(run ? { control: run.control, durability: "sync" } : {}),
      } as { signal: AbortSignal })
      const iterable = streamResult instanceof Promise ? await streamResult : streamResult

      for await (const chunk of iterable) {
        yield chunk
      }
    } catch (error) {
      if (run?.stopped(error)) {
        await retirePendingActions(entry, context)
        throw new CooperativeStopError()
      }
      throw error
    } finally {
      run?.release()
    }
  },
}
