// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { ApprovalCard } from "../../src/react/activity/ApprovalCard.js"
import { approvalPayload, scopeLine } from "../../src/view/activity-approval.js"
import type { ApprovalView } from "../../src/view/turns.js"

const approval = (o: Partial<ApprovalView> = {}): ApprovalView => ({
  interruptId: "perm-1",
  kind: "command",
  detail: {
    command: "node scripts/fetch-source.mjs https://example.org/paper",
    suggestedPattern: "node scripts/fetch-source.mjs",
  },
  message: "It isn't on this app's allow-list.",
  offersAlways: true,
  ...o,
})

describe("ApprovalCard", () => {
  test("renders the contract: title, reason, payload, three buttons on one row, scope line, role=alert", () => {
    const markup = renderToStaticMarkup(
      <ApprovalCard
        approval={approval()}
        agent="researcher"
        label="run a command"
        onDecide={() => {}}
      />,
    )
    expect(markup).toContain('<section class="b4-approval" data-state="awaiting" role="alert">')
    expect(markup).toContain(
      '<h3 class="b4-approval__title">researcher wants to run a command</h3>',
    )
    expect(markup).toContain(
      '<p class="b4-approval__reason">It isn&#x27;t on this app&#x27;s allow-list.</p>',
    )
    expect(markup).toContain(
      '<pre class="b4-approval__payload">node scripts/fetch-source.mjs https://example.org/paper</pre>',
    )
    expect(markup).toContain(
      '<div class="b4-approval__actions"><button type="button" class="b4-approval__button b4-approval__button--primary">Allow once</button><button type="button" class="b4-approval__button b4-approval__button--secondary">Always allow</button><button type="button" class="b4-approval__button b4-approval__button--text">Deny</button></div>',
    )
    expect(markup).toContain(
      '<p class="b4-approval__scope">“Always allow” applies to this exact command, for this app.</p>',
    )
  })

  test("without always: no second button and no scope line", () => {
    const markup = renderToStaticMarkup(
      <ApprovalCard
        approval={approval({ offersAlways: false })}
        agent="The agent"
        label="deploy"
        onDecide={() => {}}
      />,
    )
    expect(markup).not.toContain("Always allow")
    expect(markup).not.toContain("b4-approval__scope")
  })

  test("payload and scope helpers", () => {
    expect(approvalPayload({ argsPreview: "deployProd({env:'prod'})", command: "x" })).toBe(
      "deployProd({env:'prod'})",
    )
    expect(approvalPayload({ foo: 1, suggestedPattern: "p" })).toBe('{\n  "foo": 1\n}')
    expect(approvalPayload({})).toBe("No details")
    // A subagent dispatch gate (`kind: "subagent"`) reads as labelled lines, not JSON.
    expect(
      approvalPayload({
        parentRouteId: "/coordinator",
        subagentName: "research",
        subagentRouteId: "/coordinator/subagents/research",
        inputPreview: "Find three sources on VFR minimums",
        reason: "Delegation needs approval",
        suggestedPattern: "subagent:/coordinator:research",
      }),
    ).toBe(
      "Subagent: research (/coordinator/subagents/research)\nInput: Find three sources on VFR minimums\nReason: Delegation needs approval",
    )
    expect(approvalPayload({ subagentName: "research" })).toBe("Subagent: research")
    expect(approvalPayload({ suggestedPattern: "p" })).toBe("No details")
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(approvalPayload(cyclic)).toBe("No details")
    expect(approvalPayload({ big: 1n })).toBe("No details")
    expect(scopeLine("tool", {})).toBe(
      "“Always allow” applies to every call of this tool, for this app.",
    )
    expect(scopeLine("tool", { suggestedPattern: "deployProd" })).toBe(
      "“Always allow” applies to every call of deployProd, for this app.",
    )
    expect(scopeLine("command", {})).toBe(
      "“Always allow” applies to this exact command, for this app.",
    )
    expect(scopeLine("memory", { scope: "thread" })).toBe(
      "“Always allow” applies in this conversation only.",
    )
  })

  test("deciding disables the buttons; a rejected decision re-enables them with an inline error", async () => {
    let reject: (e: Error) => void = () => {}
    const onDecide = vi.fn(
      () =>
        new Promise<void>((_, r) => {
          reject = r
        }),
    )
    render(
      <ApprovalCard
        approval={approval()}
        agent="The agent"
        label="run a command"
        onDecide={onDecide}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(onDecide).toHaveBeenCalledWith("once")
    const card = screen.getByRole("alert")
    expect(card.getAttribute("data-state")).toBe("deciding")
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      reject(new Error("network down"))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(card.getAttribute("data-state")).toBe("failed")
    expect(screen.getByText("Couldn't send your decision: network down")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(false)
  })

  test("Always allow and Deny dispatch their decisions", () => {
    const onDecide = vi.fn()
    render(
      <ApprovalCard
        approval={approval()}
        agent="The agent"
        label="run a command"
        onDecide={onDecide}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }))
    expect(onDecide).toHaveBeenLastCalledWith("always")
    expect(screen.getByRole("alert").getAttribute("data-state")).toBe("deciding")
  })

  test("Deny dispatches deny", () => {
    const onDecide = vi.fn()
    render(
      <ApprovalCard
        approval={approval()}
        agent="The agent"
        label="run a command"
        onDecide={onDecide}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    expect(onDecide).toHaveBeenCalledWith("deny")
  })

  test("a synchronous throw from onDecide lands as a failed state with the message", async () => {
    const onDecide = vi.fn(() => {
      throw new Error("not connected")
    })
    render(
      <ApprovalCard
        approval={approval()}
        agent="The agent"
        label="run a command"
        onDecide={onDecide}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const card = screen.getByRole("alert")
    expect(card.getAttribute("data-state")).toBe("failed")
    expect(card.getAttribute("aria-busy")).toBeNull()
    expect(screen.getByText("Couldn't send your decision: not connected")).toBeTruthy()
  })

  test("a resolved decision keeps the card deciding and busy until the connector replaces it", async () => {
    const onDecide = vi.fn(() => Promise.resolve())
    render(
      <ApprovalCard
        approval={approval()}
        agent="The agent"
        label="run a command"
        onDecide={onDecide}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    const card = screen.getByRole("alert")
    expect(card.getAttribute("aria-busy")).toBe("true")
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(card.getAttribute("data-state")).toBe("deciding")
    expect(card.getAttribute("aria-busy")).toBe("true")
    expect((screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
