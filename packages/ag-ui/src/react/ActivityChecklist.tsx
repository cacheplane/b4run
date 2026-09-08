import type { B4PlanActivityContent } from "../activities.js"
import { type B4ActivityClassNames, type B4ActivityComponents, cx } from "./parts.js"

const statusPresentation = {
  pending: { glyph: "○", label: "pending" },
  in_progress: { glyph: "◐", label: "in progress" },
  completed: { glyph: "✓", label: "completed" },
} as const

export function ActivityChecklist({
  todos,
  limit = 8,
  classNames,
  components,
}: {
  todos: B4PlanActivityContent["todos"]
  limit?: number
  classNames?: B4ActivityClassNames
  components?: B4ActivityComponents
}) {
  const visibleTodos = todos.slice(0, limit)
  const overflow = todos.length - visibleTodos.length
  const TodoRow = components?.TodoRow

  return (
    <div className={cx("b4-activity__checklist", classNames?.checklist)}>
      {/* biome-ignore lint/a11y/noRedundantRoles: Markerless lists need explicit list semantics. */}
      <ol role="list" className={cx("b4-activity__list", classNames?.list)}>
        {visibleTodos.map((todo, index) => {
          const presentation = statusPresentation[todo.status]
          const itemClass = cx(
            `b4-activity__item b4-activity__item--${todo.status}`,
            classNames?.item,
          )
          if (TodoRow) {
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: Activity todos intentionally expose no stable runtime IDs.
                key={`${todo.content}:${index}`}
                className={itemClass}
              >
                <TodoRow
                  content={todo.content}
                  status={todo.status}
                  glyph={presentation.glyph}
                  label={presentation.label}
                />
              </li>
            )
          }
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: Activity todos intentionally expose no stable runtime IDs.
              key={`${todo.content}:${index}`}
              className={itemClass}
            >
              <span
                aria-hidden="true"
                className={cx("b4-activity__item-glyph", classNames?.itemGlyph)}
              >
                {presentation.glyph}
              </span>
              <span className={cx("b4-activity__item-label", classNames?.itemLabel)}>
                {todo.content}
              </span>
              <span className={cx("b4-activity__item-status", classNames?.itemStatus)}>
                {presentation.label}
              </span>
            </li>
          )
        })}
      </ol>
      {overflow > 0 ? (
        <div className={cx("b4-activity__overflow", classNames?.overflow)}>+{overflow} more</div>
      ) : null}
    </div>
  )
}
