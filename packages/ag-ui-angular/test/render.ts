import type { Type } from "@angular/core"
import type { ComponentFixture } from "@angular/core/testing"
import { TestBed } from "@angular/core/testing"
import type { ApprovalDecision } from "@b4run/ag-ui/view"
import type { ApprovalFixture, TurnFixture } from "../../ag-ui/test/fixtures/activity-fixtures.ts"
import { ApprovalCardComponent } from "../src/lib/approval-card.component"
import { TurnActivityComponent } from "../src/lib/turn-activity.component"

/** Mounts a component with these inputs and renders it synchronously. */
export function mount<T>(
  component: Type<T>,
  inputs: Readonly<Record<string, unknown>>,
): ComponentFixture<T> {
  const fixture = TestBed.createComponent(component)
  for (const [name, value] of Object.entries(inputs)) {
    if (value !== undefined) fixture.componentRef.setInput(name, value)
  }
  fixture.detectChanges()
  return fixture
}

/** Sets inputs on a mounted component and renders. */
export function update<T>(fixture: ComponentFixture<T>, inputs: Readonly<Record<string, unknown>>) {
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value)
  fixture.detectChanges()
}

/** Clicks an element and renders the result synchronously. */
export function click<T>(fixture: ComponentFixture<T>, element: Element | null | undefined): void {
  if (!element) throw new Error("click: no element")
  ;(element as HTMLElement).click()
  fixture.detectChanges()
}

/** Lets pending promise callbacks run, then renders. */
export async function settle<T>(fixture: ComponentFixture<T>): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  fixture.detectChanges()
}

export function mountTurn(fixture: TurnFixture): ComponentFixture<TurnActivityComponent> {
  return mount(TurnActivityComponent, {
    turn: fixture.turn,
    now: () => fixture.now,
    labels: fixture.labels,
    nested: fixture.nested,
  })
}

export function mountApproval(
  fixture: ApprovalFixture,
  onDecide: (decision: ApprovalDecision) => Promise<void> | void,
): ComponentFixture<ApprovalCardComponent> {
  return mount(ApprovalCardComponent, {
    approval: fixture.approval,
    agent: fixture.agent,
    label: fixture.label,
    onDecide,
  })
}

/** The button whose text is exactly `text`. */
export function button(root: Element, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)
}
