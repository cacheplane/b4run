/**
 * `@b4run/ag-ui-angular/copilotkit` — the CopilotKit Angular connector for
 * B4.run's activity kit, on `@copilotkit/angular` (an optional peer; this is
 * the only entry that imports it). `provideB4Activity` follows the chat's
 * agent into turns, `B4ActivityAssistantMessageComponent` is `<copilot-chat>`'s
 * assistant message with one activity block per turn, and
 * `B4ActivityApprovalsComponent` renders the parked interrupts' approval cards.
 */
export {
  type B4ActivityOptions,
  B4ActivityStore,
  type B4Interrupt,
  provideB4Activity,
} from "./activity-store"
export { B4ActivityApprovalsComponent } from "./approvals.component"
export { B4ActivityAssistantMessageComponent } from "./assistant-message.component"
