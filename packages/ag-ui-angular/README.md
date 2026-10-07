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
| `<b4-step-detail [args] [result]>` | `StepDetail` | A step's Inputs and Output. |
| `<b4-source-chips [sources] [limit]>` | `SourceChips` | File or URL chips with "+N" overflow. |
| `<b4-disclosure [open] [className] (toggle)>` | `Disclosure` | A `button[aria-expanded]` and its panel, for custom steps. Project the button's content with `ngProjectAs="b4-summary"`. |
| `<b4-step-icon [name]>` | `StepIcon` | The glyph for a `ToolDisplayIcon` name. |
| `<b4-checklist [todos]>` | `Checklist` | The plan's SVG checklist. |

Element hosts (`b4-turn-activity`, `b4-approval-card`, …) are `display: contents`. The step rows attach to the list item itself (`<li b4-step>`), so a turn's list is a real `ol > li` list for assistive technology and the sheet's child selectors.

`renderStep` maps a tool name to an Angular component that replaces that step's detail panel; the component receives the step as its `step` input. `labels` rewords tools on the client, as in the React kit.

The rules behind the components — wording, durations, the open/closed rule, the 300 ms no-flash rule, glyphs — come from `@b4run/ag-ui/view`, the same module the React kit renders from. The signal helpers `disclosure()`, `elapsedSignal()` and `liveSignal()` expose them for custom steps.

## Testing

The kit's tests render shared fixtures through both kits and compare them to one committed DOM-contract snapshot (`packages/ag-ui/test/fixtures/activity-contract.snap.json`), so a change to either kit that drifts from the other fails. axe runs on every fixture.
