import { computed, effect, linkedSignal, type Signal, signal, untracked } from "@angular/core"
import {
  type DisclosureMemory,
  initialDisclosure,
  isDisclosureOpen,
  noFlashRemaining,
  observeDisclosure,
  sampleElapsed,
  toggleDisclosure,
} from "@b4run/ag-ui/view"

/** A disclosure's open state and its toggle. */
export interface DisclosureState {
  readonly open: Signal<boolean>
  readonly toggle: () => void
}

/**
 * The open/closed rule (`observeDisclosure` in `@b4run/ag-ui/view`, the same
 * reducer React's `useDisclosure` runs) over signals: automation (`autoOpen`)
 * decides until the user toggles, and the user's choice holds until the item
 * is live again under a `resetKey` it has not been live under before. Without
 * a key, every rise of `live` clears the choice. Needs no injection context.
 */
export function disclosure(
  autoOpen: () => boolean,
  live: () => boolean,
  resetKey: () => unknown = () => undefined,
): DisclosureState {
  const memory = linkedSignal<{ live: boolean; key: unknown }, DisclosureMemory>({
    source: () => ({ live: live(), key: resetKey() }),
    computation: (source, previous) =>
      previous === undefined
        ? initialDisclosure(source.live, source.key)
        : observeDisclosure(previous.value, source.live, source.key),
  })
  return {
    open: computed(() => isDisclosureOpen(memory(), autoOpen())),
    toggle: () => memory.set(toggleDisclosure(memory(), autoOpen())),
  }
}

/**
 * `now()` re-sampled once a second while `active` (`sampleElapsed`); the last
 * sample otherwise. Call in an injection context (a field initializer): the
 * timer is an effect, cleared with the component.
 */
export function elapsedSignal(active: () => boolean, now: () => number): Signal<number> {
  const sample = signal<number | undefined>(undefined)
  effect((onCleanup) => {
    const on = active()
    untracked(() => {
      if (on) onCleanup(sampleElapsed(now, (time) => sample.set(time)))
      else sample.set(now())
    })
  })
  return computed(() => sample() ?? untracked(now))
}

/**
 * Whether a tool step shows as running: running for at least `NO_FLASH_MS`
 * (`noFlashRemaining`), so a call that settles fast never flashes a spinner.
 * Call in an injection context: the timeout is an effect.
 */
export function liveSignal(
  step: () => { readonly status: string; readonly startedAt: number },
  now: () => number,
): Signal<boolean> {
  const running = computed(() => step().status === "running")
  const startedAt = computed(() => step().startedAt)
  const past = signal<boolean | undefined>(undefined)
  effect((onCleanup) => {
    if (!running()) return
    const started = startedAt()
    untracked(() => {
      const remaining = noFlashRemaining(started, now())
      if (remaining === 0) {
        past.set(true)
        return
      }
      past.set(false)
      const id = setTimeout(() => past.set(true), remaining)
      onCleanup(() => clearTimeout(id))
    })
  })
  return computed(
    () => running() && (past() ?? untracked(() => noFlashRemaining(startedAt(), now()) === 0)),
  )
}
