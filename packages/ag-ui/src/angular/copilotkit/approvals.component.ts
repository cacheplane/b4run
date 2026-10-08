import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core"
import { type ApprovalDecision, approvalFromInterrupt, approvalPrompt } from "@b4run/ag-ui/view"
import { ApprovalCardComponent } from "../index.js"
import { B4ActivityStore } from "./activity-store.js"

/**
 * One `<b4-approval-card>` per interrupt CopilotKit holds open
 * (`injectInterrupt`), titled "{agent} wants to {label}" from the turns
 * (`approvalPrompt`). A click marks the resume, then resolves (`once`,
 * `always`) or cancels (`deny`) through CopilotKit; a failure clears the mark
 * and shows on the card. Give it to `<copilot-chat>` as
 * `[messageViewChildrenComponent]` (after the messages), or place it anywhere
 * under `provideB4Activity`.
 *
 * The title uses the gated step's running label, lower-cased: phrase
 * `display.running` as an infinitive ("run a command") so the card reads
 * "The agent wants to run a command". A step with no running label (a
 * restored parked call) reads "wants to use <tool>".
 */
@Component({
  selector: "b4-activity-approvals",
  imports: [ApprovalCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `@for (card of cards(); track card.approval.interruptId) {<b4-approval-card [approval]="card.approval" [agent]="card.agent" [label]="card.label" [onDecide]="card.onDecide" />}`,
})
export class B4ActivityApprovalsComponent {
  readonly #store = inject(B4ActivityStore)
  protected readonly cards = computed(() => {
    const turns = this.#store.turns()
    return this.#store.interrupts().map((interrupt) => ({
      approval: approvalFromInterrupt(interrupt),
      ...approvalPrompt(turns, interrupt, this.#store.labels),
      onDecide: (decision: ApprovalDecision) => this.#store.decide(interrupt.id, decision),
    }))
  })
}
