import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SubagentStep } from "../../src/react/activity/SubagentStep.js"
import type { ToolStep, TurnView, SubagentStep as View } from "../../src/view/turns.js"

const tool = (id: string): ToolStep => ({
  kind: "tool",
  id,
  name: "readDoc",
  status: "done",
  args: "",
  startedAt: 0,
  settledAt: 5,
  label: "Read a.md",
})
const nested = (status: TurnView["status"]): TurnView => ({
  runId: "c",
  status,
  startedAt: 0,
  ...(status === "working" || status === "awaiting" ? {} : { endedAt: 9000 }),
  steps: [tool("n1"), tool("n2")],
  text: "",
  approvals: [],
  failed: 0,
})
/**
 * `Partial` that also accepts an explicit `undefined`, so a case can unset a
 * default (`settledAt: undefined`); {@link compact} then drops the key, which
 * `exactOptionalPropertyTypes` requires of the built view.
 */
type Loose<T> = { [K in keyof T]?: T[K] | undefined }
const compact = <T extends object>(o: Loose<T>): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
const sub = (o: Loose<View>): View =>
  compact<View>({
    kind: "subagent",
    id: "s",
    name: "researcher",
    description: "summarize ReAct",
    status: "done",
    startedAt: 0,
    settledAt: 9000,
    turn: nested("done"),
    ...o,
  })
const zero = () => 0
const thousand = () => 1000

describe("SubagentStep", () => {
  test("running reads Asked researcher to …, is open, and nests the child's activity", () => {
    const markup = renderToStaticMarkup(
      <SubagentStep
        step={sub({ status: "running", settledAt: undefined, turn: nested("working") })}
        now={thousand}
      />,
    )
    expect(markup).toContain(
      '<li class="b4-step" data-state="running" data-kind="subagent" data-expanded="true">',
    )
    expect(markup).toContain(
      '<span class="b4-step__text">Asked <b>researcher</b> to summarize ReAct</span>',
    )
    expect(markup).toContain(
      '<div class="b4-step__children"><section class="b4-turn" data-state="working"',
    )
  })

  test("paused maps to awaiting; done folds to researcher finished · N steps", () => {
    expect(
      renderToStaticMarkup(
        <SubagentStep
          step={sub({ status: "paused", settledAt: undefined, turn: nested("awaiting") })}
          now={zero}
        />,
      ),
    ).toContain('data-state="awaiting" data-kind="subagent"')
    const done = renderToStaticMarkup(<SubagentStep step={sub({})} now={zero} />)
    expect(done).toContain('data-state="done" data-kind="subagent">')
    expect(done).toContain(
      '<span class="b4-step__text">researcher finished</span><span class="b4-step__meta">· 2 steps</span>',
    )
    expect(done).not.toContain("b4-step__children")
  })

  test("failed reads researcher failed with the error", () => {
    const markup = renderToStaticMarkup(
      <SubagentStep
        step={sub({ status: "failed", error: "boom", turn: nested("failed") })}
        now={zero}
      />,
    )
    expect(markup).toContain('data-state="failed" data-kind="subagent" data-expanded="true"')
    expect(markup).toContain(
      '<span class="b4-step__text">researcher failed</span><span class="b4-step__meta">· boom</span>',
    )
  })
})
