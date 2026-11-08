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
  settled(): Promise<void>
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

  const inFlight = new Set<Promise<unknown>>()
  const record = <T>(promise: Promise<T>): Promise<T> => {
    promise = new OwnedWritePromise<T>((resolve, reject) => {
      promise.then(resolve, reject)
    })
    inFlight.add(promise)
    const forget = () => inFlight.delete(promise)
    promise.then(forget, forget)
    return promise
  }

  const proxy = new Proxy(saver, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (property === "put" || property === "putWrites") {
        return (...args: unknown[]) =>
          record(Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args)))
      }
      // Bound to the real saver so private fields and `this`-sensitive
      // methods behave exactly as they do unwrapped.
      return (value as (...a: unknown[]) => unknown).bind(target)
    },
  })

  const entry: TrackedCheckpointer = {
    saver: proxy,
    async settled() {
      // LangGraph issues its remaining writes from promise continuations of
      // the failure itself, so yield a macrotask to let them START before
      // waiting for what is in flight. Bounded: a write that is still being
      // issued after a few rounds is not part of this turn's teardown.
      for (let round = 0; round < 3; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (inFlight.size === 0) return
        await Promise.allSettled([...inFlight])
      }
    },
  }
  tracked.set(saver, entry)
  return entry
}
