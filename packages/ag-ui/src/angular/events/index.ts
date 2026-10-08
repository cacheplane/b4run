/**
 * `@b4run/ag-ui/angular/events` — the activity kit's connector for any
 * Angular chat, with no chat framework: a `B4TurnsStore` folds the thread's
 * AG-UI event stream into turns, `<b4-message-activity>` renders a turn's
 * activity in a per-message slot (once per turn), and `<b4-approvals>`
 * renders the parked interrupts' approval cards for the host to resume.
 */
export { ApprovalsComponent, type B4ApprovalDecision } from "./approvals.component.js"
export { MessageActivityComponent } from "./message-activity.component.js"
export {
  type B4EventStream,
  type B4TurnEvent,
  type B4TurnsOptions,
  B4TurnsStore,
  createB4Turns,
  provideB4Turns,
} from "./turns-store.js"
