import {
  assertInInjectionContext,
  DestroyRef,
  Injector,
  inject,
  type Provider,
  type Signal,
  signal,
} from "@angular/core"
import {
  EMPTY_TURNS,
  type ReduceTurnsOptions,
  reduceTurns,
  type StepLabelOverrides,
  type TurnsView,
} from "@b4run/ag-ui/view"
import type { StepRenderers } from "../index.js"

/** One AG-UI event, as `reduceTurns` folds it. */
export type B4TurnEvent = Parameters<typeof reduceTurns>[1]

/**
 * A stream of AG-UI events: an RxJS `Observable<BaseEvent>` fits, and so does
 * anything with the same `subscribe`.
 */
export interface B4EventStream {
  subscribe(observer: { next: (event: B4TurnEvent) => void }): { unsubscribe(): void }
}

export interface B4TurnsOptions {
  /** The thread's events, live and replayed, in order. Without it, call `connect` or `apply`. */
  readonly events$?: B4EventStream | undefined
  /** Tools whose frames the view drops entirely (`ReduceTurnsOptions.hiddenTools`). */
  readonly hiddenTools?: readonly string[] | undefined
  /** Per-tool label overrides; the components read them from the store. */
  readonly labels?: StepLabelOverrides | undefined
  /** Per-tool step components; the components read them from the store. */
  readonly renderStep?: StepRenderers | undefined
  /**
   * The clock for events that carry no `timestamp` (live events); defaults to
   * `Date.now`. An event with a numeric `timestamp` (a replay) is folded at
   * that time instead. Inject in tests.
   */
  readonly now?: (() => number) | undefined
}

const defaultNow = (): number => Date.now()

/**
 * A thread's turns, kept current from its AG-UI event stream: the Angular
 * counterpart of the React connector's `useB4Turns`, with no chat framework.
 * Each event is folded through `reduceTurns` into the `turns` signal; an event
 * with a numeric `timestamp` (a restored thread's replay) is folded at that
 * time, so a restored turn keeps its real durations.
 *
 * Create one per chat with `createB4Turns` or `provideB4Turns`; the
 * `./events` components inject it.
 */
export class B4TurnsStore {
  readonly #turns = signal<TurnsView>(EMPTY_TURNS)
  /** The thread as turns. */
  readonly turns: Signal<TurnsView> = this.#turns.asReadonly()
  readonly labels: StepLabelOverrides | undefined
  readonly renderStep: StepRenderers | undefined
  readonly hiddenTools: readonly string[] | undefined
  readonly now: () => number
  #resuming = false
  #subscription: { unsubscribe(): void } | undefined

  constructor(options: B4TurnsOptions = {}) {
    this.labels = options.labels
    this.renderStep = options.renderStep
    this.hiddenTools = options.hiddenTools
    this.now = options.now ?? defaultNow
    if (options.events$ !== undefined) this.connect(options.events$)
  }

  /**
   * Follow `events$` instead of the current stream: the view starts over
   * from empty (a new stream replays the thread from its start).
   */
  connect(events$: B4EventStream): void {
    this.disconnect()
    this.#turns.set(EMPTY_TURNS)
    this.#subscription = events$.subscribe({ next: (event) => this.apply(event) })
  }

  /** Stop following the current stream; the turns stay as they are. */
  disconnect(): void {
    this.#subscription?.unsubscribe()
    this.#subscription = undefined
  }

  /** Fold one event, for a host that pushes events instead of handing over a stream. */
  apply(event: B4TurnEvent): void {
    const isRunStart = event.type === "RUN_STARTED"
    // A replayed event is folded at the time it happened, not when it arrived.
    const stamped = event.timestamp
    const clock = typeof stamped === "number" && Number.isFinite(stamped) ? () => stamped : this.now
    const options: ReduceTurnsOptions = {
      now: clock,
      ...(this.hiddenTools !== undefined ? { hiddenTools: this.hiddenTools } : {}),
      ...(isRunStart && this.#resuming ? { resuming: true } : {}),
    }
    if (isRunStart) this.#resuming = false
    this.#turns.update((previous) => reduceTurns(previous, event, options))
  }

  /**
   * Call right before sending a resume: the next `RUN_STARTED` then continues
   * the awaiting turn instead of guessing (`ReduceTurnsOptions.resuming`).
   */
  markResuming(): void {
    this.#resuming = true
  }

  /** Forget a `markResuming()` whose resume never went out (the request failed). */
  clearResuming(): void {
    this.#resuming = false
  }

  /**
   * Replace the turns: empty by default, or a view restored some other way
   * (`turnsFromState`, `GET /threads/:id/turns`). The stream, if any, keeps
   * folding onto it.
   */
  reset(turns: TurnsView = EMPTY_TURNS): void {
    this.#resuming = false
    this.#turns.set(turns)
  }

  /** Stop following the stream. `createB4Turns` and `provideB4Turns` call this on destroy. */
  destroy(): void {
    this.disconnect()
  }
}

/**
 * A `B4TurnsStore` that stops following its stream when the calling context
 * is destroyed. Call it in an injection context (a component's field or
 * constructor), or pass `injector`.
 */
export function createB4Turns(
  options: B4TurnsOptions & { readonly injector?: Injector | undefined } = {},
): B4TurnsStore {
  if (options.injector === undefined) assertInInjectionContext(createB4Turns)
  const injector = options.injector ?? inject(Injector)
  const store = new B4TurnsStore(options)
  injector.get(DestroyRef).onDestroy(() => store.destroy())
  return store
}

/**
 * Provides a `B4TurnsStore` to a component's subtree (`providers` of the chat
 * component), a route or an application. `options` may be a function, called in the
 * injection context, so it can `inject()` the service that owns the stream.
 */
export function provideB4Turns(options: B4TurnsOptions | (() => B4TurnsOptions) = {}): Provider {
  return {
    provide: B4TurnsStore,
    useFactory: () => createB4Turns(typeof options === "function" ? options() : options),
  }
}

/** The store an `./events` component reads: its `store` input, else the injected one. */
export function resolveStore(
  given: B4TurnsStore | undefined,
  injected: B4TurnsStore | null,
): B4TurnsStore {
  const store = given ?? injected
  if (store === null) {
    throw new Error(
      "No B4TurnsStore: pass [store], or add provideB4Turns(...) to a parent's providers",
    )
  }
  return store
}
