<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180" />
</p>

# @b4run/ag-ui-angular

The B4.run activity kit for Angular: standalone components that show what an agent did in a turn — its steps, plan, reasoning, subagents and approvals — in plain language.

**Use this when:** You are building an Angular chat on a B4.run agent and want each turn's activity rendered the way the React kit (`@b4run/ag-ui/react`) renders it.

> **Status: not published yet.** The package is `private` in this repository while its npm name and trusted publisher are set up; it joins the B4.run release train after that. Everything below works inside the monorepo today.

## Install

```bash
pnpm add @b4run/ag-ui-angular
```

Requires Angular 22 or later (`@angular/core`, `@angular/common`, `@angular/compiler`, `@angular/platform-browser` as peers). `@b4run/ag-ui`, which builds the views the components render, is a dependency. The package is built with ng-packagr in partial-compilation mode, so your Angular build links it.

## Example

Fold the AG-UI event stream into turns with `reduceTurns` from `@b4run/ag-ui/view`, then render each turn:

```ts
import { Component, signal } from "@angular/core"
import { TurnActivityComponent } from "@b4run/ag-ui-angular"
import { EMPTY_TURNS, reduceTurns, type TurnsView } from "@b4run/ag-ui/view"

@Component({
  selector: "app-activity",
  imports: [TurnActivityComponent],
  template: `
    @for (turn of turns().turns; track turn.runId) {
      <b4-turn-activity [turn]="turn" />
    }
  `,
})
export class ActivityComponent {
  readonly turns = signal<TurnsView>(EMPTY_TURNS)

  /** Call with every AG-UI event of the thread, in order. */
  onEvent(event: Parameters<typeof reduceTurns>[1]) {
    this.turns.update((state) => reduceTurns(state, event))
  }
}
```

For a parked interrupt, render a `<b4-approval-card>` after the turn's activity and resume the run from its `onDecide`:

```html
<b4-approval-card [approval]="approval" agent="The agent" label="run a command" [onDecide]="decide" />
```

And load the stylesheet once, for example in `angular.json`'s `styles` or a global stylesheet:

```css
@import "@b4run/ag-ui-angular/styles.css";
```

## Components

Every component is standalone, uses `OnPush` and signal inputs, and renders the same DOM contract — classes, `data-*` and `aria-*` attributes, text — as its React counterpart, so the one shared sheet styles both.

| Angular | React | What it renders |
|---|---|---|
| `<b4-turn-activity [turn]>` | `TurnActivity` | The summary line plus the step list for one turn, nested for subagents. Inputs: `turn`, `labels`, `renderStep`, `now`, `nested`. |
| `<b4-approval-card [approval] [agent] [label] [onDecide]>` | `ApprovalCard` | A parked interrupt: who wants what, why, the payload, Allow once / Always allow / Deny, and the scope line. `onDecide` runs on the click; a throw or rejection shows inline and re-enables the buttons. |
| `<li b4-step [step]>` | `Step` | One tool call as a sentence; opens to its inputs and output. |
| `<li b4-step-group [group]>` | `StepGroup` | Consecutive done calls of one tool, merged. |
| `<li b4-plan-step [step] [live]>` | `PlanStep` | "Made a plan · 2 of 4 done" with the checklist. |
| `<li b4-reasoning-step [step]>` | `ReasoningStep` | "Thinking…", "Thought for 4s" or "Show reasoning". |
| `<li b4-subagent-step [step]>` | `SubagentStep` | "Asked researcher" with the child's activity nested. |
| `<b4-step-detail [args] [result]>` | `StepDetail` | A step's input and result: rows, plain text or pretty JSON, with "Show raw" when rows reshaped a value. |
| `<b4-source-chips [sources] [limit]>` | `SourceChips` | File or URL chips with "+N" overflow. |
| `<b4-disclosure [open] [className] (toggle)>` | `Disclosure` | A `button[aria-expanded]` and its panel, for custom steps. Project the button's content with `ngProjectAs="b4-summary"`. |
| `<b4-step-icon [name]>` | `StepIcon` | The glyph for a `ToolDisplayIcon` name. |
| `<b4-checklist [todos]>` | `Checklist` | The plan's SVG checklist. |

Element hosts (`b4-turn-activity`, `b4-approval-card`, …) are `display: contents`. The step rows attach to the list item itself (`<li b4-step>`), so a turn's list is a real `ol > li` list for assistive technology and the sheet's child selectors.

`renderStep` maps a tool name to an Angular component that replaces that step's detail panel; the component receives the step as its `step` input. `labels` rewords tools on the client, as in the React kit.

The rules behind the components — wording, durations, the open/closed rule, the 300 ms no-flash rule, glyphs — come from `@b4run/ag-ui/view`, the same module the React kit renders from. The signal helpers `disclosure()`, `elapsedSignal()` and `liveSignal()` expose them for custom steps.

## Connectors

Two entry points fold a thread's AG-UI events into turns and place the components in a chat. Both find a message's turn with `turnForMessage` from `@b4run/ag-ui/view` (the turn whose tool calls the message's run carries, else by position from the end of the thread) and render one activity block per turn, on the turn's first assistant message.

### `@b4run/ag-ui-angular/events` — any chat

No chat framework: give it the thread's AG-UI events (an RxJS `Observable<BaseEvent>`, or anything with the same `subscribe`).

```ts
import { Component, inject, input } from "@angular/core"
import {
  ApprovalsComponent,
  type B4ApprovalDecision,
  MessageActivityComponent,
  provideB4Turns,
} from "@b4run/ag-ui-angular/events"
// ThreadEvents: your service that owns the thread's AG-UI event stream and sends resumes.

@Component({
  selector: "app-chat",
  imports: [MessageActivityComponent, ApprovalsComponent],
  providers: [provideB4Turns(() => ({ events$: inject(ThreadEvents).events$ }))],
  template: `
    @for (message of messages(); track message.id) {
      <app-message [message]="message" />
      <b4-message-activity [messageId]="message.id" [messages]="messages()" />
    }
    <b4-approvals [resume]="resume" />
  `,
})
export class ChatComponent {
  readonly messages = input.required<Message[]>()
  readonly #thread = inject(ThreadEvents)
  readonly resume = ({ interruptId, decision }: B4ApprovalDecision) =>
    this.#thread.resume(interruptId, decision)
}
```

| Export | What |
|---|---|
| `B4TurnsStore` | The thread as a `turns` signal, folded by `reduceTurns`. An event with a numeric `timestamp` (a replay) is folded at that time, so a restored turn keeps its real durations. `connect(events$)` follows a new stream from empty, `apply(event)` folds one event, `reset(turns?)` seeds a restored view (`turnsFromState`), `markResuming()`/`clearResuming()` as in the React connector, `destroy()`. Options: `events$`, `hiddenTools`, `labels`, `renderStep`, `now`. |
| `createB4Turns(options)` | A store that stops following its stream when the calling injection context is destroyed (or pass `injector`). |
| `provideB4Turns(options \| () => options)` | Provides a store to a subtree; the function form runs in the injection context, so it can `inject()` the stream's owner. |
| `<b4-message-activity [messageId] [messages] [store]?>` | The turn's `<b4-turn-activity>` on its first assistant message, nothing on the others. `messages` is the host's transcript (anything with `id`, `role` and the assistant's `toolCalls`). |
| `<b4-approvals [resume]? (decide) [store]?>` | One `<b4-approval-card>` per parked interrupt, read from the turns (`pendingApprovals`). |

The approvals contract: a click calls the store's `markResuming()` (so the resumed run's `RUN_STARTED` continues the awaiting turn), then emits `(decide)` with `{ interruptId, decision }`. `once` and `always` resolve the interrupt with that value, `deny` cancels it. With `[resume]`, the component also awaits it; a throw or rejection calls `clearResuming()` and shows on the card, which offers the buttons again. A host that resumes from `(decide)` alone calls `clearResuming()` itself when its resume fails.

### `@b4run/ag-ui-angular/copilotkit` — CopilotKit's `<copilot-chat>`

On `@copilotkit/angular` 0.5.3 or later (an optional peer; this is the only entry that imports it).

```ts
import { Component, inject } from "@angular/core"
import { CopilotChat } from "@copilotkit/angular"
import {
  B4ActivityApprovalsComponent,
  B4ActivityAssistantMessageComponent,
  B4ActivityStore,
  provideB4Activity,
} from "@b4run/ag-ui-angular/copilotkit"

@Component({
  selector: "app-chat",
  imports: [CopilotChat],
  providers: [provideB4Activity({ agentId: "navlog", renderStep: { computeNavlog: NavlogStep } })],
  template: `<copilot-chat agentId="navlog"
    [assistantMessageComponent]="assistant"
    [messageViewChildrenComponent]="approvals" />`,
})
export class ChatComponent {
  readonly activity = inject(B4ActivityStore) // created with the chat, so it sees every event
  readonly assistant = B4ActivityAssistantMessageComponent
  readonly approvals = B4ActivityApprovalsComponent
}
```

| Export | What |
|---|---|
| `provideB4Activity({ agentId?, labels?, hiddenTools?, renderStep?, now? })` | A `B4ActivityStore` for the subtree, also provided as `B4TurnsStore`. Inject it in the providing component: Angular creates a provider when something first injects it, and the store sees only the events after it exists. |
| `B4ActivityStore` | Follows the agent from `injectAgentStore` (`agent.subscribe({ onEvent })`, CopilotKit's `connect` replay included) into `turns`, and the parked interrupts from `injectInterrupt` into `interrupts`. `decide(interruptId, decision)` marks the resume, then resolves or cancels through CopilotKit, and clears the mark when CopilotKit throws. |
| `B4ActivityAssistantMessageComponent` | `<copilot-chat>`'s assistant message: the message's text through CopilotKit's own assistant message (markdown, toolbar) without CopilotKit's tool-call rows, then the turn's `<b4-turn-activity>` on the turn's first assistant message. Tool-only messages render nothing of their own; a subagent's messages render nothing. |
| `B4ActivityApprovalsComponent` | One `<b4-approval-card>` per interrupt CopilotKit holds open, as `<copilot-chat>`'s `[messageViewChildrenComponent]` (after the messages) or anywhere under `provideB4Activity`. |

`renderStep` maps a tool name to a component that replaces that step's detail panel; it receives the step as its `step` input. Grants: CopilotKit's `resolve(payload)` carries only the decision, so the connector supports `approvals.grants: "off"`; with `"optional"` or `"required"` the server answers the resume with 409. The card's title is "{agent} wants to {label}" with the gated step's running label lower-cased, so phrase `display.running` as an infinitive ("run a command").

## Testing

The kit's tests render shared fixtures through both kits and compare them to one committed DOM-contract snapshot (`packages/ag-ui/test/fixtures/activity-contract.snap.json`), so a change to either kit that drifts from the other fails. axe runs on every fixture. The connectors are tested against a live `Subject`, a timestamped replay, parked approvals, failed runs and nested subagents; the CopilotKit connector against a scripted AG-UI agent through CopilotKit's own `injectAgentStore`, `injectInterrupt` and `<copilot-chat>`, and what both render through a chat slot matches the same snapshot.
