import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SubagentPanel } from "../../src/react/SubagentPanel.js"
import type { SubagentRun } from "../../src/react/useSubagentRuns.js"

function run(
  overrides: Partial<SubagentRun> & { subagentRunId: string; name: string },
): SubagentRun {
  return {
    status: "running",
    children: [],
    toolCalls: [],
    text: "",
    reasoning: "",
    ...overrides,
  }
}

describe("SubagentPanel", () => {
  test("renders nothing for no runs", () => {
    expect(renderToStaticMarkup(<SubagentPanel runs={new Map()} />)).toBe("")
  })

  test("renders a tree: parent open while running, nested child badged, tools with args and results", () => {
    const runs = new Map<string, SubagentRun>([
      [
        "c1",
        run({
          subagentRunId: "c1",
          name: "researcher",
          description: "Finds sources",
          children: ["c2"],
          reasoning: "look it up",
          text: "Searching now",
          plan: [{ content: "read", status: "in_progress" }],
          toolCalls: [
            { id: "t1", name: "search", args: '{"q":"x"}', result: "3 hits", status: "completed" },
            { id: "t2", name: "readDoc", args: "", status: "running" },
          ],
        }),
      ],
      [
        "c2",
        run({
          subagentRunId: "c2",
          name: "reader",
          parentSubagentRunId: "c1",
          status: "completed",
          result: "done reading",
        }),
      ],
    ])
    const markup = renderToStaticMarkup(<SubagentPanel runs={runs} />)
    expect(markup).toContain("researcher")
    expect(markup).toContain("Finds sources")
    expect(markup).toContain("look it up")
    expect(markup).toContain("Searching now")
    expect(markup).toContain("read")
    expect(markup).toContain("{&quot;q&quot;:&quot;x&quot;}")
    expect(markup).toContain("3 hits")
    expect(markup).toContain("2 tools")
    expect(markup).toContain("reader")
    expect(markup).toContain("done reading")
    expect(markup).toContain("nested")
    // The running parent is open; the completed child is not.
    expect(markup.match(/<details open/g)).toHaveLength(1)
    expect(markup.match(/b4-activity__children/g)?.length).toBeGreaterThanOrEqual(2)
    // Status modifiers drive the per-item hooks the stylesheet styles.
    expect(markup).toContain("b4-activity__item--completed")
    expect(markup).toContain("b4-activity__item--running")
  })

  test("a failed run shows its error as an alert; a suspended one stays open", () => {
    const runs = new Map<string, SubagentRun>([
      ["c1", run({ subagentRunId: "c1", name: "a", status: "failed", error: "boom" })],
      ["c2", run({ subagentRunId: "c2", name: "b", status: "suspended" })],
    ])
    const markup = renderToStaticMarkup(<SubagentPanel runs={runs} />)
    expect(markup).toMatch(/role="alert"[^>]*>boom</)
    expect(markup).toContain("waiting for approval")
    expect(markup.match(/<details open/g)).toHaveLength(1)
  })

  test("classNames append and a ToolRow slot replaces tool rows", () => {
    const runs = new Map<string, SubagentRun>([
      [
        "c1",
        run({
          subagentRunId: "c1",
          name: "a",
          toolCalls: [{ id: "t", name: "search", args: "{}", status: "running" }],
        }),
      ],
    ])
    const markup = renderToStaticMarkup(
      <SubagentPanel
        runs={runs}
        classNames={{ root: "my-root", title: "my-title" }}
        components={{ ToolRow: ({ name }) => <b>{name}</b> }}
      />,
    )
    expect(markup).toContain('class="b4-activity b4-activity--running my-root"')
    expect(markup).toContain("my-title")
    expect(markup).toContain("<b>search</b>")
    expect(markup).not.toContain("b4-activity__item-glyph")
  })
})
