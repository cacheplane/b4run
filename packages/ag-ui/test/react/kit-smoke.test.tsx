// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { TurnActivity } from "../../src/react/index.js"
import type { TurnView } from "../../src/view/turns.js"
import { TURN_FIXTURES } from "../fixtures/activity-fixtures.ts"

/** A settled research turn: reasoning, a plan, two merged searches, a subagent, a write. */
const turn = TURN_FIXTURES["done research turn"]?.turn as TurnView

describe("kit smoke", () => {
  test("a settled research turn renders folded with the right summary, and open with every row kind", () => {
    const folded = renderToStaticMarkup(<TurnActivity turn={turn} now={() => 0} />)
    expect(folded).toContain("Worked for 1m 12s")
    expect(folded).toContain("· 8 steps · 2 sources")
    expect(folded).not.toContain("b4-turn__steps")
  })

  test("clicking the summary opens one row per top-level step, nested rows staying folded", () => {
    render(<TurnActivity turn={turn} now={() => 0} />)
    fireEvent.click(screen.getByRole("button", { name: /Worked for 1m 12s/ }))
    const kinds = screen
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("data-kind"))
      .filter(Boolean)
    expect(kinds).toEqual(["reasoning", "plan", "group", "subagent", "tool"])
  })
})
