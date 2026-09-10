import type { B4PlanActivityContent } from "../activities.js"
import { ActivityChecklist } from "./ActivityChecklist.js"
import { type B4ActivityClassNames, type B4ActivityComponents, cx } from "./parts.js"

export function PlanActivityCard({
  content,
  classNames,
  components,
}: {
  content: B4PlanActivityContent
  classNames?: B4ActivityClassNames
  components?: B4ActivityComponents
}) {
  const completedCount = content.todos.filter((todo) => todo.status === "completed").length
  const hasActiveTodo = content.todos.some((todo) => todo.status === "in_progress")

  return (
    <details open={hasActiveTodo} className={cx("b4-activity", classNames?.root)}>
      <summary className={cx("b4-activity__header", classNames?.header)}>
        {/* `aria-hidden`: `<details>` already announces its own expanded state, and
            the glyph would otherwise land in the summary's accessible name. */}
        <span aria-hidden="true" className={cx("b4-activity__marker", classNames?.marker)}>
          ▸
        </span>
        <span className={cx("b4-activity__title", classNames?.title)}>Plan</span>
        <span className={cx("b4-activity__meta", classNames?.meta)}>
          {" "}
          · {completedCount}/{content.todos.length} complete
        </span>
      </summary>
      <ActivityChecklist
        todos={content.todos}
        limit={8}
        {...(classNames ? { classNames } : {})}
        {...(components ? { components } : {})}
      />
    </details>
  )
}
