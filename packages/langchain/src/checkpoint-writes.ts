import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"

/**
 * A checkpointer whose in-flight writes can be awaited.
 *
 * LangGraph persists checkpoints asynchronously: when a graph run fails, its
 * stream rejects while writes the run already issued can still be landing, and
 * the checkpoint that owns a parked interrupt's `__interrupt__` write can be
 * put AFTER the rejection. Callers that read the checkpoint the moment a turn
 * fails (the parked-route gate records which route owns a park by diffing the
 * pending interrupts across the turn) would then miss a park that becomes
 * durable a moment later. Draining the writes before the failure propagates
 * makes "the turn has settled" mean "the turn has stopped writing".
 */
export interface TrackedCheckpointer {
  /** The checkpointer to hand the graph; it records every write it forwards. */
  readonly saver: BaseCheckpointSaver
  /** Resolves once every write the graph has issued so far has settled. */
  settled(threadId?: string): Promise<void>
}

const tracked = new WeakMap<BaseCheckpointSaver, TrackedCheckpointer>()

/** Pinned LangGraph stores a rejection-rethrow continuation and awaits it only
 * after sibling tasks finish. Observe that SAME rejected promise immediately;
 * its eventual await still rejects with the original write error. Scoped to
 * owned writes, with native Promise species and no global rejection handler. */
class OwnedWritePromise<T> extends Promise<T> {
  static override get [Symbol.species]() {
    return Promise
  }
  // biome-ignore lint/suspicious/noThenProperty: This Promise subclass intentionally observes each unchanged derived rejection.
  override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const child = super.then(onfulfilled, onrejected)
    void Promise.prototype.then.call(child, undefined, () => undefined)
    return child
  }
}

/**
 * The tracked form of `saver`, one per saver instance, so a graph cached per
 * checkpointer and the adapter that drains it always share the same tracker.
 */
export function trackCheckpointWrites(saver: BaseCheckpointSaver): TrackedCheckpointer {
  const existing = tracked.get(saver)
  if (existing) return existing

  const inFlight = new Map<Promise<unknown>, string | undefined>()
  const failures: { threadId: string | undefined; error: unknown }[] = []
  const record = <T>(promise: Promise<T>, threadId: string | undefined): Promise<T> => {
    promise = new OwnedWritePromise<T>((resolve, reject) => {
      promise.then(resolve, reject)
    })
    inFlight.set(promise, threadId)
    promise.then(
      () => inFlight.delete(promise),
      (error) => {
        failures.push({ threadId, error })
        inFlight.delete(promise)
      },
    )
    return promise
  }

  const proxy = new Proxy(saver, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (property === "put" || property === "putWrites") {
        return (...args: unknown[]) =>
          record(
            Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args)),
            (args[0] as { configurable?: { thread_id?: string } })?.configurable?.thread_id,
          )
      }
      // Bound to the real saver so private fields and `this`-sensitive
      // methods behave exactly as they do unwrapped.
      return (value as (...a: unknown[]) => unknown).bind(target)
    },
  })

  const entry: TrackedCheckpointer = {
    saver: proxy,
    async settled(threadId) {
      // A graph can issue writes from teardown continuations. Wait for all of
      // this thread's writes, without turning a rejected write into success.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        const pending = [...inFlight]
          .filter(([, owner]) => threadId === undefined || owner === threadId)
          .map(([promise]) => promise)
        if (pending.length === 0) break
        await Promise.allSettled(pending)
      }
      const selected = failures.filter(
        (failure) => threadId === undefined || failure.threadId === threadId,
      )
      for (let index = failures.length - 1; index >= 0; index--) {
        if (threadId === undefined || failures[index]?.threadId === threadId)
          failures.splice(index, 1)
      }
      const first = selected[0]
      if (first) throw first.error
    },
  }
  tracked.set(saver, entry)
  return entry
}
