import { ChangeDetectionStrategy, Component, computed, inject, input, output } from "@angular/core"
import { type ApprovalDecision, pendingApprovals } from "@b4run/ag-ui/view"
import { ApprovalCardComponent } from "../index.js"
import { B4TurnsStore, resolveStore } from "./turns-store.js"

/** A decision on one parked interrupt. */
export interface B4ApprovalDecision {
  readonly interruptId: string
  readonly decision: ApprovalDecision
}

/**
 * One `<b4-approval-card>` per parked interrupt of the thread, read from the
 * turns (`pendingApprovals`): every awaiting step of the last turn, nested
 * subagents included, then the interrupts that named no step. The host sends
 * the resume; the cards go away when the resumed run starts.
 *
 * The resume contract: on a click the component calls `markResuming()` on the
 * store, so the resumed run's `RUN_STARTED` continues the awaiting turn, then
 * emits `(decide)`. With `[resume]`, it also calls that function and awaits
 * it: a throw or rejection calls `clearResuming()` and shows on the card,
 * which offers the buttons again. A host that resumes from `(decide)` alone
 * must call the store's `clearResuming()` itself when its resume fails.
 * `once` and `always` resolve the interrupt with that value; `deny` cancels it.
 */
@Component({
  selector: "b4-approvals",
  imports: [ApprovalCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `@for (card of cards(); track card.approval.interruptId) {<b4-approval-card [approval]="card.approval" [agent]="card.agent" [label]="card.label" [onDecide]="card.onDecide" />}`,
})
export class ApprovalsComponent {
  /** The turns; defaults to the injected `B4TurnsStore`. */
  readonly storeInput = input<B4TurnsStore | undefined>(undefined, { alias: "store" })
  /** Sends the resume; a throw or rejection shows on the card. */
  readonly resume = input<((decision: B4ApprovalDecision) => Promise<void> | void) | undefined>(
    undefined,
  )
  /** A decision, after `markResuming()`. */
  readonly decide = output<B4ApprovalDecision>()

  readonly #injected = inject(B4TurnsStore, { optional: true })
  protected readonly store = computed(() => resolveStore(this.storeInput(), this.#injected))
  protected readonly cards = computed(() => {
    const store = this.store()
    return pendingApprovals(store.turns(), store.labels).map((card) => ({
      ...card,
      onDecide: (decision: ApprovalDecision) =>
        this.#decide(store, { interruptId: card.approval.interruptId, decision }),
    }))
  })

  async #decide(store: B4TurnsStore, decision: B4ApprovalDecision): Promise<void> {
    store.markResuming()
    this.decide.emit(decision)
    const resume = this.resume()
    if (resume === undefined) return
    try {
      await resume(decision)
    } catch (cause) {
      // No resume went out; the next RUN_STARTED must not glue onto this turn.
      store.clearResuming()
      throw cause
    }
  }
}
