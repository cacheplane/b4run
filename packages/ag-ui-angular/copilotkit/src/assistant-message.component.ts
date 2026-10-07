import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core"
import { isSubagentMessage, turnForMessage } from "@b4run/ag-ui/view"
import { TurnActivityComponent } from "@b4run/ag-ui-angular"
import {
  type AssistantMessage,
  CopilotChatAssistantMessage,
  type Message,
} from "@copilotkit/angular"
import { B4ActivityStore } from "./activity-store"

/** Renders nothing: B4.run's activity replaces CopilotKit's tool-call rows. */
@Component({
  selector: "b4-no-tool-calls",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: "",
})
export class NoToolCallsComponent {}

const hasText = (content: unknown): boolean =>
  (typeof content === "string" && content.trim() !== "") ||
  (Array.isArray(content) &&
    content.some((p) => {
      const part = p as { type?: unknown; text?: unknown }
      return (
        typeof part === "object" &&
        part !== null &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim() !== ""
      )
    }))

/**
 * `<copilot-chat>`'s assistant message (`[assistantMessageComponent]`):
 * the message's text through CopilotKit's own `<copilot-chat-assistant-message>`
 * (markdown and toolbar), without CopilotKit's tool-call rows, then — on the
 * turn's first assistant message only — one `<b4-turn-activity>` for the
 * turn. A tool-only message renders nothing of its own, and a subagent's
 * message nothing at all (its text lives inside the nested turn), so each
 * turn shows one activity block where React's `mergeTurnMessages` puts it.
 * The turn is found by `turnForMessage` (`@b4run/ag-ui/view`).
 *
 * Its inputs are the ones `<copilot-chat>` binds on the slot. Needs
 * `provideB4Activity` above it.
 */
@Component({
  selector: "b4-activity-assistant-message",
  imports: [CopilotChatAssistantMessage, TurnActivityComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `@if (!subagent()) {@if (text()) {<copilot-chat-assistant-message [message]="message()" [messages]="messages()" [isLoading]="isLoading()" [inputClass]="inputClass()" [toolCallsViewComponent]="noToolCalls" />}@if (turn(); as t) {<b4-turn-activity [turn]="t" [labels]="store.labels" [renderStep]="store.turnsStore.renderStep" [now]="store.turnsStore.now" />}}`,
})
export class B4ActivityAssistantMessageComponent {
  readonly message = input.required<AssistantMessage>()
  readonly messages = input<Message[]>([])
  readonly isLoading = input<boolean>(false)
  readonly inputClass = input<string | undefined>(undefined)

  protected readonly store = inject(B4ActivityStore)
  protected readonly noToolCalls = NoToolCallsComponent
  protected readonly subagent = computed(() => isSubagentMessage(this.message()))
  protected readonly text = computed(() => hasText(this.message().content))
  protected readonly turn = computed(() => {
    const found = turnForMessage(this.store.turns(), this.messages(), this.message().id)
    return found?.first ? found.turn : undefined
  })
}
