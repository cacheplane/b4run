import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core"
import {
  type ApprovalDecision,
  type ApprovalView,
  approvalArgsRows,
  approvalErrorLine,
  approvalPayload,
  dispatchDecision,
  scopeLine,
} from "@b4run/ag-ui/view"

/**
 * The approval card (spec §3.2): one per pending interrupt, after the turn's
 * activity. "{agent} wants to {label}", the reason, the payload (a tool
 * call's arguments as rows when they are a JSON object), Allow once /
 * Always allow / Deny on one row, and the scope line. `onDecide` runs on the
 * click; when it throws or rejects, the card says so and offers the buttons
 * again.
 */
@Component({
  selector: "b4-approval-card",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `<section class="b4-approval" [attr.data-state]="state()" role="alert" [attr.aria-busy]="busy() ? 'true' : null"><h3 class="b4-approval__title">{{ agent() }} wants to {{ label() }}</h3>@if (approval().message) {<p class="b4-approval__reason">{{ approval().message }}</p>}@if (rows(); as rows) {<dl class="b4-approval__payload b4-approval__args">@for (row of rows; track row.key) {<div class="b4-approval__arg"><dt>{{ row.key }}</dt><dd>@if (row.full !== undefined) {<details class="b4-approval__more"><summary>{{ row.value }}</summary><span class="b4-approval__full">{{ row.full }}</span></details>} @else {<ng-container>{{ row.value }}</ng-container>}</dd></div>}</dl>} @else {<pre class="b4-approval__payload">{{ payload() }}</pre>}<div class="b4-approval__actions"><button type="button" class="b4-approval__button b4-approval__button--primary" [disabled]="busy()" (click)="decide('once')">Allow once</button>@if (approval().offersAlways) {<button type="button" class="b4-approval__button b4-approval__button--secondary" [disabled]="busy()" (click)="decide('always')">Always allow</button>}<button type="button" class="b4-approval__button b4-approval__button--text" [disabled]="busy()" (click)="decide('deny')">Deny</button></div>@if (error() !== undefined) {<p class="b4-approval__error">{{ errorLine() }}</p>}@if (approval().offersAlways) {<p class="b4-approval__scope">{{ scope() }}</p>}</section>`,
})
export class ApprovalCardComponent {
  readonly approval = input.required<ApprovalView>()
  /** "The agent" for the root run, the subagent's name otherwise. */
  readonly agent = input.required<string>()
  /** The gated step's running label, lower-cased by the caller: "run a command". */
  readonly label = input.required<string>()
  readonly onDecide = input.required<(decision: ApprovalDecision) => Promise<void> | void>()

  protected readonly state = signal<"awaiting" | "deciding" | "failed">("awaiting")
  protected readonly error = signal<string | undefined>(undefined)
  protected readonly busy = computed(() => this.state() === "deciding")
  protected readonly rows = computed(() => approvalArgsRows(this.approval().detail))
  protected readonly payload = computed(() => approvalPayload(this.approval().detail))
  protected readonly scope = computed(() => scopeLine(this.approval().kind, this.approval().detail))
  protected readonly errorLine = computed(() => approvalErrorLine(this.error() ?? ""))

  protected decide(decision: ApprovalDecision): void {
    this.state.set("deciding")
    this.error.set(undefined)
    dispatchDecision(
      () => this.onDecide()(decision),
      (message) => {
        this.state.set("failed")
        this.error.set(message)
      },
    )
  }
}
