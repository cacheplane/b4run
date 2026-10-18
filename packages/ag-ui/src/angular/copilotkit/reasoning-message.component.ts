import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type InputSignal,
  inject,
  input,
} from "@angular/core"
import { reasoningInActivity } from "@b4run/ag-ui/view"
import { CopilotChatReasoningMessage, type Message } from "@copilotkit/angular"
import { B4ActivityStore } from "./activity-store.js"

/** The reasoning message `<copilot-chat>` binds, as CopilotKit's own component types it. */
type ReasoningMessage = ReturnType<CopilotChatReasoningMessage["message"]>

/**
 * `<copilot-chat>`'s reasoning message (`[reasoningMessageComponent]`):
 * CopilotKit's own `<copilot-chat-reasoning-message>`, except for reasoning
 * the turn's `<b4-turn-activity>` already shows as a reasoning step — a turn
 * with a tool or subagent step — where it renders nothing, so the span does not
 * read "Thought for 40 seconds" twice. A turn that only reasoned and answered
 * has no activity block, so its reasoning keeps CopilotKit's row. The check is
 * `reasoningInActivity` (`@b4run/ag-ui/view`), the one React's
 * `useB4ChatSlots` uses.
 *
 * Its inputs are the ones `<copilot-chat>` binds on the slot. Needs
 * `provideB4Activity` above it.
 */
@Component({
  selector: "b4-activity-reasoning-message",
  imports: [CopilotChatReasoningMessage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `@if (!inActivity()) {<copilot-chat-reasoning-message [message]="message()" [messages]="messages()" [isRunning]="isRunning()" [inputClass]="inputClass()" />}`,
})
export class B4ActivityReasoningMessageComponent {
  readonly message: InputSignal<ReasoningMessage> = input.required<ReasoningMessage>()
  readonly messages = input<Message[]>([])
  readonly isRunning = input<boolean>(false)
  readonly inputClass = input<string | undefined>(undefined)

  protected readonly store = inject(B4ActivityStore)
  protected readonly inActivity = computed(() =>
    reasoningInActivity(this.store.turns(), this.message().id),
  )
}
