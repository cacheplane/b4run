// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, test } from "vitest"

function Counter() {
  const [n, setN] = useState(0)
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      clicks: {n}
    </button>
  )
}

describe("jsdom environment", () => {
  test("renders and handles a click", () => {
    render(<Counter />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByRole("button").textContent).toBe("clicks: 1")
  })
})
