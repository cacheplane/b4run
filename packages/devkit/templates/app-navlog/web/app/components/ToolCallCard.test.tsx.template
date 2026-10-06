import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { cardOutcome, RESULT_PREVIEW_LIMIT, ToolCallView, ToolStepsContext } from "./ToolCallCard"

/**
 * Stubbed for its side effects, not its behavior: importing
 * `@copilotkit/react-core/v2` for real pulls in `dist/v2/index.css`, which Node
 * cannot load, so the suite fails to even collect. `ToolCallView` — everything
 * these tests assert on — touches no CopilotKit hook at all.
 */
vi.mock("@copilotkit/react-core/v2", () => ({ useRenderTool: () => {} }))

/**
 * The card's own render function, rendered directly. `ToolCallCard` is
 * registration-only — it calls `useRenderTool` and returns null — so there is
 * nothing to assert on it.
 */
function render(props: Parameters<typeof ToolCallView>[0]): string {
  return renderToStaticMarkup(<ToolCallView {...props} />)
}

/** The visible text, tags stripped, so assertions read like what a person sees. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    // Last, so an escaped entity such as "&amp;quot;" is decoded once, not twice.
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

describe("tool card headline", () => {
  test("titles a call in plain words and keeps the exact tool name as its own tag", () => {
    const markup = render({
      name: "getMetar",
      status: "complete",
      parameters: { ids: ["kfcm", "kdlh"] },
      result: JSON.stringify([
        { id: "KFCM", flightCategory: "VFR" },
        { id: "KDLH", flightCategory: "VFR" },
      ]),
    })
    expect(text(markup)).toContain("Current weather (METAR) for KFCM, KDLH")
    expect(text(markup)).toContain("2 airports VFR")
    // The journeys find a card by `getByText(name, { exact: true })`: the name
    // must be one element's whole text, exactly once.
    expect(markup.match(/>getMetar</g)).toHaveLength(1)
  })

  test("unwraps the double-encoded `input` the live stream sends", () => {
    const markup = render({
      name: "readDoc",
      status: "executing",
      parameters: { input: '{"path":"poh/cruise-performance.md"}' },
    })
    expect(text(markup)).toContain("Reading POH: cruise performance")
    // The double-encoded wrapper never reaches the reader.
    expect(markup).not.toContain("&quot;input&quot;")
  })

  test("titles a subagent dispatch by the briefer it runs", () => {
    const markup = render({
      name: "task",
      status: "executing",
      parameters: { input: '{"subagent":"weather","description":"brief KSTP to KRST"}' },
    })
    expect(text(markup)).toContain("Weather briefer")
    expect(text(markup)).toContain("brief KSTP to KRST")
    expect(markup.match(/>task</g)).toHaveLength(1)
  })

  test("falls back to the humanized name for a tool it has no wording for", () => {
    const markup = render({ name: "somethingElse", status: "executing", parameters: { alpha: 1 } })
    expect(text(markup)).toContain("Something else")
  })

  test("uses the server's step label for a tool the client has no summary for", () => {
    const markup = renderToStaticMarkup(
      <ToolStepsContext.Provider
        value={new Map([["c1", { toolCallId: "c1", status: "completed", label: "Did a thing" }]])}
      >
        <ToolCallView
          name="mysteryTool"
          status="complete"
          parameters={{}}
          toolCallId="c1"
          result="ok"
        />
      </ToolStepsContext.Provider>,
    )
    expect(text(markup)).toContain("Did a thing")
  })

  test("never shows a memory id in the human summary", () => {
    const markup = render({
      name: "recall",
      status: "complete",
      parameters: { query: "aircraft profile and pilot preferences" },
      result:
        "memory_98f81ea4afc0e25a: Aircraft tail number N738ZU\nmemory_1234abcd: Cruise 2400 RPM",
    })
    expect(text(markup)).toContain("Checked saved aircraft profile")
    expect(text(markup)).toContain("2 saved facts")
    expect(markup).not.toContain("memory_98f81ea4afc0e25a")
  })
})

describe("tool card details", () => {
  test("keeps the raw arguments and result behind a collapsed Details button", () => {
    const markup = render({
      name: "readDoc",
      status: "complete",
      parameters: { path: "poh/cruise-performance.md" },
      result: "the document body",
    })
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Details/)
    expect(markup).not.toContain("the document body")
    // A button, never <details>: the journeys count root tool names inside
    // <details> to tell a root call from a subagent's.
    expect(markup).not.toContain("<details")
  })

  test("shows the tool's output text, not LangChain internals, when expanded", () => {
    const markup = render({
      name: "readDoc",
      status: "complete",
      parameters: { path: "poh/cruise-performance.md" },
      result: "the document body",
      defaultExpanded: true,
    })
    expect(markup).toMatch(/aria-expanded="true"/)
    expect(markup).toContain("the document body")
    expect(markup).toContain("poh/cruise-performance.md")
    expect(markup).not.toContain("langchain_core")
  })

  test("shows a `{ content }` document as the document, not escaped JSON", () => {
    const markup = render({
      name: "readDoc",
      status: "complete",
      parameters: {},
      result: JSON.stringify({ content: "# Cruise\nline two" }),
      defaultExpanded: true,
    })
    expect(markup).toContain("# Cruise\nline two")
  })

  test("pretty-prints a JSON result", () => {
    const markup = render({
      name: "somethingElse",
      status: "complete",
      parameters: {},
      result: '{"a":1,"b":2}',
      defaultExpanded: true,
    })
    expect(markup).toContain("&quot;a&quot;: 1")
  })

  test("suppresses a result that arrives before the call is complete", () => {
    const markup = render({
      name: "runBash",
      status: "executing",
      parameters: {},
      result: "half a directory listing",
      defaultExpanded: true,
    })
    expect(markup).not.toContain("half a directory listing")
  })

  test("bounds a long result instead of filling the transcript", () => {
    const long = "x".repeat(RESULT_PREVIEW_LIMIT + 250)
    const markup = render({
      name: "readDoc",
      status: "complete",
      parameters: {},
      result: long,
      defaultExpanded: true,
    })
    expect(markup).toContain("x".repeat(RESULT_PREVIEW_LIMIT))
    expect(markup).not.toContain(long)
    expect(markup).toContain("+250 more characters")
  })
})

describe("tool card status", () => {
  test("each outcome has its own mark and accessible label", () => {
    const base = { name: "readDoc", parameters: {} } as const
    expect(render({ ...base, status: "inProgress" })).toContain('aria-label="Running"')
    expect(render({ ...base, status: "executing" })).toContain('aria-label="Running"')
    expect(render({ ...base, status: "complete", result: "ok" })).toContain('aria-label="Done"')
    expect(render({ ...base, status: "complete", result: "Error: boom" })).toContain(
      'aria-label="Failed"',
    )
    expect(
      render({ ...base, status: "complete", result: "Permission denied by user: tool readDoc" }),
    ).toContain('aria-label="Denied"')
  })

  test("the server's step outranks the result text", () => {
    expect(cardOutcome("complete", "ok", { toolCallId: "c", status: "failed" })).toBe("error")
    expect(cardOutcome("complete", "ok", { toolCallId: "c", status: "denied" })).toBe("denied")
    expect(cardOutcome("executing", undefined, undefined)).toBe("running")
  })

  test("does not claim success the wire never carried", () => {
    // A finished call with no error text is "done", drawn muted — not the
    // package's green `--b4-activity-complete`, which would read as "succeeded".
    const markup = render({ name: "runBash", status: "complete", parameters: {}, result: "ok" })
    expect(markup).not.toContain("b4-activity-complete")
  })

  test("carries no inline styles or hard-coded greys", () => {
    const markup = render({ name: "readDoc", status: "executing", parameters: {} })
    expect(markup).not.toContain("style=")
    expect(markup).not.toContain("#e5e5e5")
  })
})
