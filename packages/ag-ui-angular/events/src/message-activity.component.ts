import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core"
import { type TranscriptMessage, turnForMessage } from "@b4run/ag-ui/view"
import { TurnActivityComponent } from "@b4run/ag-ui-angular"
import { B4TurnsStore, resolveStore } from "./turns-store"

/**
 * The activity for the turn an assistant message belongs to, for a chat with
 * one slot per message: rendered on the turn's first assistant message only
 * (nothing on the others, user messages or subagent messages), so each turn
 * shows one `<b4-turn-activity>`. The turn is found as `turnForMessage`
 * (`@b4run/ag-ui/view`) finds it: by the tool calls of the message's run,
 * else by position from the end of the thread.
 *
 * ```html
 * <b4-message-activity [messageId]="message.id" [messages]="messages()" />
 * ```
 */
@Component({
  selector: "b4-message-activity",
  imports: [TurnActivityComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `@if (turn(); as t) {<b4-turn-activity [turn]="t" [labels]="store().labels" [renderStep]="store().renderStep" [now]="store().now" />}`,
})
export class MessageActivityComponent {
  /** The id of the message this slot renders. */
  readonly messageId = input.required<string>()
  /** The host's transcript, in order (AG-UI `Message`s, or anything with id, role and toolCalls). */
  readonly messages = input.required<readonly TranscriptMessage[]>()
  /** The turns; defaults to the injected `B4TurnsStore`. */
  readonly storeInput = input<B4TurnsStore | undefined>(undefined, { alias: "store" })

  readonly #injected = inject(B4TurnsStore, { optional: true })
  protected readonly store = computed(() => resolveStore(this.storeInput(), this.#injected))
  protected readonly turn = computed(() => {
    const found = turnForMessage(this.store().turns(), this.messages(), this.messageId())
    return found?.first ? found.turn : undefined
  })
}
