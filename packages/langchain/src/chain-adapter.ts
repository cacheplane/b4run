import type { BackendAdapter } from "@b4run/sdk"
import { ownRunnableExecution } from "@b4run/sdk/internal/execution-work"

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
    context: { readonly signal: AbortSignal },
  ): Promise<unknown> {
    assertRunnableLike(entry)
    const owned = ownRunnableExecution(entry).entry
    return await owned.invoke(input, { signal: context.signal })
  },

  async *stream(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): AsyncIterable<unknown> {
    assertRunnableLike(entry)
    const owned = ownRunnableExecution(entry).entry

    if (typeof owned.stream !== "function") {
      yield await owned.invoke(input, { signal: context.signal })
      return
    }

    const streamResult = owned.stream(input, { signal: context.signal })
    const iterable = streamResult instanceof Promise ? await streamResult : streamResult

    for await (const chunk of iterable) {
      yield chunk
    }
  },
}
