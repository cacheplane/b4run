import type { ReactElement } from "react"
import type { B4PlanActivityContent } from "../../activities.js"
import { planProgress, todoStatusLabel } from "../../view/activity-format.js"
import { CHECKLIST_TICK, checklistBox } from "../../view/activity-glyphs.js"
import type { PlanStep as PlanStepView } from "../../view/turns.js"
import { Disclosure, useDisclosure } from "./Disclosure.js"
import { GlyphShapeElement, StepIcon } from "./icons.js"
import { StatusText } from "./StatusText.js"

/** The plan's checklist (spec §3 `PlanStep`): SVG boxes, done items struck through by CSS. */
export function Checklist({
  todos,
}: {
  readonly todos: B4PlanActivityContent["todos"]
}): ReactElement {
  return (
    <ol className="b4-checklist" aria-label="Plan">
      {todos.map((todo, index) => {
        const completed = todo.status === "completed"
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: Plan todos carry no stable id and two may share content; the list is updated in place, never reordered.
            key={`${index}:${todo.content}`}
            className="b4-checklist__item"
            data-status={todo.status}
          >
            <svg
              className="b4-checklist__box"
              viewBox="0 0 14 14"
              width="14"
              height="14"
              aria-hidden="true"
              focusable="false"
            >
              <GlyphShapeElement shape={checklistBox(completed)} />
              {completed ? <GlyphShapeElement shape={CHECKLIST_TICK} /> : null}
            </svg>
            <span className="b4-checklist__text">{todo.content}</span>
            <span className="b4-visually-hidden">{todoStatusLabel(todo.status)}</span>
          </li>
        )
      })}
    </ol>
  )
}

export interface PlanStepProps {
  readonly step: PlanStepView
  /** Whether the owning turn is still working; the plan is running only then (spec §3). */
  readonly live: boolean
}

/** "Made a plan · 2 of 4 done" with the checklist (spec §3 `PlanStep`). Updates in place. */
export function PlanStep({ step, live }: PlanStepProps): ReactElement {
  const { done, total } = planProgress(step.todos)
  const { open, toggle } = useDisclosure(live, live, step.startedAt)
  return (
    <li
      className="b4-step"
      data-state={live ? "running" : "done"}
      data-kind="plan"
      {...(open ? { "data-expanded": "true" } : {})}
    >
      <Disclosure
        className="b4-step__line"
        open={open}
        onToggle={toggle}
        panelClassName="b4-step__children"
        summary={
          <>
            <StepIcon name="plan" />
            <span className="b4-step__text">Made a plan</span>
            <StatusText>{`· ${done} of ${total} done`}</StatusText>
          </>
        }
      >
        <Checklist todos={step.todos} />
      </Disclosure>
    </li>
  )
}
