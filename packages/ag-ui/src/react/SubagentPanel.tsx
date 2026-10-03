import { ActivityChecklist } from "./ActivityChecklist.js"
import { type B4ActivityClassNames, type B4ActivityComponents, cx } from "./parts.js"
import type { SubagentRun, SubagentToolCall } from "./useSubagentRuns.js"

const statusLabel = {
  running: "running",
  completed: "completed",
  suspended: "waiting for approval",
  failed: "failed",
} as const

const toolStatusPresentation = {
  running: { glyph: "◐", label: "running" },
  completed: { glyph: "✓", label: "completed" },
} as const

/**
 * The subagent tree, from `useSubagentRuns`: one disclosure card per
 * invocation, nested under the invocation that dispatched it. Shows what the
 * attributed stream carried — the child's reasoning and prose, its plan, its
 * tool calls with their arguments and results, and its result or error.
 *
 * Styled with the same `b4-activity` classes and tokens as the plan card, so
 * the customization ladder (tokens, `classNames`, `components`) applies
 * unchanged.
 */
export function SubagentPanel({
  runs,
  classNames,
  components,
}: {
  runs: ReadonlyMap<string, SubagentRun>
  classNames?: B4ActivityClassNames
  components?: B4ActivityComponents
}) {
  const roots = [...runs.values()].filter(
    (run) => run.parentSubagentRunId === undefined || !runs.has(run.parentSubagentRunId),
  )
  if (roots.length === 0) return null
  return (
    <div className="b4-activity__children b4-activity__children--root">
      {roots.map((run) => (
        <SubagentCard
          key={run.subagentRunId}
          run={run}
          runs={runs}
          {...(classNames ? { classNames } : {})}
          {...(components ? { components } : {})}
        />
      ))}
    </div>
  )
}

function SubagentCard({
  run,
  runs,
  classNames,
  components,
}: {
  run: SubagentRun
  runs: ReadonlyMap<string, SubagentRun>
  classNames?: B4ActivityClassNames
  components?: B4ActivityComponents
}) {
  const children = run.children
    .map((id) => runs.get(id))
    .filter((child): child is SubagentRun => child !== undefined)
  const nested = run.parentSubagentRunId !== undefined
  const result = typeof run.result === "string" ? run.result : undefined
  return (
    <details
      open={run.status === "running" || run.status === "suspended"}
      className={cx(`b4-activity b4-activity--${run.status}`, classNames?.root)}
    >
      <summary className={cx("b4-activity__header", classNames?.header)}>
        {/* `aria-hidden`: `<details>` already announces its own expanded state, and
            the glyph would otherwise land in the summary's accessible name. */}
        <span aria-hidden="true" className={cx("b4-activity__marker", classNames?.marker)}>
          ▸
        </span>
        <span className={cx("b4-activity__title", classNames?.title)}>{run.name}</span>
        <span className={cx("b4-activity__meta", classNames?.meta)}>
          {" "}
          · {statusLabel[run.status]}
        </span>
        <span className={cx("b4-activity__meta", classNames?.meta)}>
          {" "}
          · {run.toolCalls.length} tools
        </span>
        {nested ? (
          <span className={cx("b4-activity__badge", classNames?.badge)}>nested</span>
        ) : null}
      </summary>

      {run.description !== undefined ? (
        <p className={cx("b4-activity__description", classNames?.meta)}>{run.description}</p>
      ) : null}

      {run.reasoning.length > 0 ? (
        <section
          aria-label="Subagent reasoning"
          className={cx("b4-activity__section", classNames?.section)}
        >
          <div className={cx("b4-activity__section-label", classNames?.sectionLabel)}>
            Reasoning
          </div>
          <p className="b4-activity__reasoning">{run.reasoning}</p>
        </section>
      ) : null}

      {run.plan !== undefined ? (
        <section
          aria-label="Subagent plan"
          className={cx("b4-activity__section", classNames?.section)}
        >
          <div className={cx("b4-activity__section-label", classNames?.sectionLabel)}>Plan</div>
          <ActivityChecklist
            todos={run.plan}
            limit={8}
            {...(classNames ? { classNames } : {})}
            {...(components ? { components } : {})}
          />
        </section>
      ) : null}

      {run.toolCalls.length > 0 ? (
        <section
          aria-label="Subagent tools"
          className={cx("b4-activity__section", classNames?.section)}
        >
          <div className={cx("b4-activity__section-label", classNames?.sectionLabel)}>Tools</div>
          {/* biome-ignore lint/a11y/noRedundantRoles: Markerless lists need explicit list semantics. */}
          <ul role="list" className={cx("b4-activity__list", classNames?.list)}>
            {run.toolCalls.map((call) => (
              <ToolRow
                key={call.id}
                call={call}
                {...(classNames ? { classNames } : {})}
                {...(components ? { components } : {})}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {run.text.length > 0 ? <p className="b4-activity__text">{run.text}</p> : null}

      {result !== undefined && result !== run.text ? (
        <p className="b4-activity__result">{result}</p>
      ) : null}

      {run.error !== undefined ? (
        <p role="alert" className={cx("b4-activity__error", classNames?.error)}>
          {run.error}
        </p>
      ) : null}

      {children.length > 0 ? (
        <div className="b4-activity__children">
          {children.map((child) => (
            <SubagentCard
              key={child.subagentRunId}
              run={child}
              runs={runs}
              {...(classNames ? { classNames } : {})}
              {...(components ? { components } : {})}
            />
          ))}
        </div>
      ) : null}
    </details>
  )
}

function ToolRow({
  call,
  classNames,
  components,
}: {
  call: SubagentToolCall
  classNames?: B4ActivityClassNames
  components?: B4ActivityComponents
}) {
  const presentation = toolStatusPresentation[call.status]
  const Row = components?.ToolRow
  const itemClass = cx(`b4-activity__item b4-activity__item--${call.status}`, classNames?.item)
  if (Row) {
    return (
      <li className={itemClass}>
        <Row
          name={call.name}
          status={call.status}
          glyph={presentation.glyph}
          label={presentation.label}
        />
      </li>
    )
  }
  return (
    <li className={itemClass}>
      <span aria-hidden="true" className={cx("b4-activity__item-glyph", classNames?.itemGlyph)}>
        {presentation.glyph}
      </span>
      <span className={cx("b4-activity__item-label", classNames?.itemLabel)}>{call.name}</span>
      <span className={cx("b4-activity__item-status", classNames?.itemStatus)}>
        {presentation.label}
      </span>
      {call.args.length > 0 ? <code className="b4-activity__item-args">{call.args}</code> : null}
      {call.result !== undefined ? (
        <span className="b4-activity__item-result">{call.result}</span>
      ) : null}
    </li>
  )
}
