import { ChangeDetectionStrategy, Component, input } from "@angular/core"
import type { B4PlanActivityContent } from "@b4run/ag-ui"
import { CHECKLIST_TICK, checklistBox, todoStatusLabel } from "@b4run/ag-ui/view"
import { SvgAttrsDirective } from "./svg"

type Todo = B4PlanActivityContent["todos"][number]

/** The plan's checklist: SVG boxes, done items struck through by CSS. */
@Component({
  selector: "b4-checklist",
  imports: [SvgAttrsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: "display: contents" },
  template: `<ol class="b4-checklist" aria-label="Plan">@for (todo of todos(); track $index) {<li class="b4-checklist__item" [attr.data-status]="todo.status"><svg class="b4-checklist__box" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false"><svg:rect [b4SvgAttrs]="box(todo).attrs" />@if (todo.status === "completed") {<svg:path [b4SvgAttrs]="tick.attrs" />}</svg><span class="b4-checklist__text">{{ todo.content }}</span><span class="b4-visually-hidden">{{ statusLabel(todo.status) }}</span></li>}</ol>`,
})
export class ChecklistComponent {
  readonly todos = input.required<readonly Todo[]>()
  protected readonly tick = CHECKLIST_TICK
  protected readonly statusLabel = todoStatusLabel
  protected box(todo: Todo) {
    return checklistBox(todo.status === "completed")
  }
}
