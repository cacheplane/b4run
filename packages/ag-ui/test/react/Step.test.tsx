// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { Step } from "../../src/react/activity/Step.js"
import type { ToolStep } from "../../src/view/turns.js"

/**
 * `Partial` that also accepts an explicit `undefined`, so a case can unset a
 * default (`settledAt: undefined`); {@link compact} then drops the key, which
 * `exactOptionalPropertyTypes` requires of the built view.
 */
type Loose<T> = { [K in keyof T]?: T[K] | undefined }
const compact = <T extends object>(o: Loose<T>): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

const tool = (o: Loose<ToolStep> & { id: string; name: string }): ToolStep =>
  compact<ToolStep>({
    kind: "tool",
    status: "done",
    args: '{"query":"a"}',
    startedAt: 0,
    settledAt: 1000,
    ...o,
  })
const now = () => 10_000

describe("Step", () => {
  test("renders the DOM contract with the server label and sources, closed by default", () => {
    const markup = renderToStaticMarkup(
      <Step
        step={tool({
          id: "a",
          name: "searchCorpus",
          icon: "search",
          label: "Searched the corpus",
          sources: [{ title: "a.md" }],
        })}
        now={now}
      />,
    )
    expect(markup).toContain('<li class="b4-step" data-state="done" data-kind="tool">')
    expect(markup).toContain('<button type="button" class="b4-step__line" aria-expanded="false">')
    expect(markup).toContain('<span class="b4-step__text">Searched the corpus</span>')
    expect(markup).toContain('class="b4-step__sources"')
    expect(markup).not.toContain("b4-step__detail")
  })

  test("falls back to Used x / an override, and a running step reads as pending for 300 ms", () => {
    expect(renderToStaticMarkup(<Step step={tool({ id: "a", name: "x" })} now={now} />)).toContain(
      ">Used x<",
    )
    expect(
      renderToStaticMarkup(
        <Step
          step={tool({ id: "a", name: "x" })}
          labels={{ x: { done: () => "Did x" } }}
          now={now}
        />,
      ),
    ).toContain(">Did x<")
    const fresh = renderToStaticMarkup(
      <Step
        step={tool({
          id: "a",
          name: "x",
          status: "running",
          startedAt: 9_900,
          settledAt: undefined,
        })}
        now={now}
      />,
    )
    expect(fresh).toContain('data-state="pending"')
    const old = renderToStaticMarkup(
      <Step
        step={tool({ id: "a", name: "x", status: "running", startedAt: 0, settledAt: undefined })}
        now={now}
      />,
    )
    expect(old).toContain('data-state="running"')
  })

  test("a denied step reads Denied x with its own icon, a denied meta, and stays closed", () => {
    const denied = renderToStaticMarkup(
      <Step
        step={tool({ id: "a", name: "searchCorpus", status: "denied", icon: "search" })}
        now={now}
      />,
    )
    expect(denied).toContain('data-state="denied" data-kind="tool"')
    expect(denied).not.toContain('data-expanded="true"')
    expect(denied).toContain("Denied searchCorpus")
    expect(denied).toContain('<span class="b4-step__meta">· denied</span>')
    // The tool's own glyph, not the alert a failed step swaps in.
    const glyph = (markup: string) => markup.match(/<svg class="b4-step__icon"[\s\S]*?<\/svg>/)?.[0]
    const failed = renderToStaticMarkup(
      <Step
        step={tool({ id: "a", name: "searchCorpus", status: "failed", icon: "search" })}
        now={now}
      />,
    )
    const searching = renderToStaticMarkup(
      <Step
        step={tool({ id: "a", name: "searchCorpus", status: "done", icon: "search" })}
        now={now}
      />,
    )
    expect(glyph(denied)).toBe(glyph(searching))
    expect(glyph(denied)).not.toBe(glyph(failed))
  })

  test("awaiting and failed add meta; a failed step opens itself", () => {
    expect(
      renderToStaticMarkup(
        <Step step={tool({ id: "a", name: "x", status: "awaiting" })} now={now} />,
      ),
    ).toContain('<span class="b4-step__meta">· awaiting approval</span>')
    expect(
      renderToStaticMarkup(
        <Step step={tool({ id: "a", name: "x", status: "failed", result: undefined })} now={now} />,
      ),
    ).toContain('<span class="b4-step__meta">· failed</span>')
    const failed = renderToStaticMarkup(
      <Step step={tool({ id: "a", name: "x", status: "failed", result: "ENOENT" })} now={now} />,
    )
    expect(failed).toContain('data-state="failed" data-kind="tool" data-expanded="true"')
    expect(failed).toContain('aria-expanded="true"')
    expect(failed).toContain("ENOENT")
    expect(failed).not.toContain("b4-step__meta")
  })

  test("clicking opens the detail; renderStep replaces it", () => {
    const { rerender } = render(
      <Step step={tool({ id: "a", name: "x", result: "3 hits" })} now={now} />,
    )
    expect(screen.queryByText("3 hits")).toBeNull()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("3 hits")).toBeTruthy()
    expect(screen.getByRole("listitem").getAttribute("data-expanded")).toBe("true")
    rerender(
      <Step
        step={tool({ id: "a", name: "x", result: "3 hits" })}
        now={now}
        renderStep={{ x: ({ step }) => <table data-testid="t">{step.result}</table> }}
      />,
    )
    expect(screen.getByTestId("t").textContent).toBe("3 hits")
    expect(screen.queryByText("Inputs")).toBeNull()
  })

  test("a step opened while awaiting stays open when the same call starts running", () => {
    const awaiting = tool({
      id: "a",
      name: "x",
      status: "awaiting",
      startedAt: 0,
      settledAt: undefined,
    })
    const { rerender } = render(<Step step={awaiting} now={now} />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByRole("listitem").getAttribute("data-expanded")).toBe("true")
    rerender(<Step step={{ ...awaiting, status: "running" }} now={now} />)
    expect(screen.getByRole("listitem").getAttribute("data-state")).toBe("running")
    expect(screen.getByRole("listitem").getAttribute("data-expanded")).toBe("true")
  })

  test("a call that restarts (new startedAt) while running hands the disclosure back to automation", () => {
    const running = tool({
      id: "a",
      name: "x",
      status: "running",
      startedAt: 0,
      settledAt: undefined,
    })
    const { rerender } = render(<Step step={running} now={now} />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByRole("listitem").getAttribute("data-expanded")).toBe("true")
    rerender(<Step step={{ ...running, startedAt: 5_000 }} now={now} />)
    expect(screen.getByRole("listitem").getAttribute("data-state")).toBe("running")
    expect(screen.getByRole("listitem").getAttribute("data-expanded")).toBeNull()
  })
})
