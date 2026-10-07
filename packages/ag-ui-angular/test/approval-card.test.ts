import type { ApprovalView } from "@b4run/ag-ui/view"
import { describe, expect, test, vi } from "vitest"
import { ApprovalCardComponent } from "../src/lib/approval-card.component"
import { button, click, mount, settle } from "./render"

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

function card(
  onDecide: (decision: string) => Promise<void> | void,
  o: Partial<ApprovalView> = {},
  agent = "The agent",
) {
  const fixture = mount(ApprovalCardComponent, {
    approval: approval(o),
    agent,
    label: "run a command",
    onDecide,
  })
  const root = fixture.nativeElement as HTMLElement
  const section = () => root.querySelector("section.b4-approval") as HTMLElement
  return { fixture, root, section }
}

describe("b4-approval-card", () => {
  test("renders the contract: title, reason, payload, three buttons on one row, scope line, role=alert", () => {
    const { root, section } = card(() => {}, {}, "researcher")
    expect(section().getAttribute("data-state")).toBe("awaiting")
    expect(section().getAttribute("role")).toBe("alert")
    expect(section().hasAttribute("aria-busy")).toBe(false)
    expect(root.querySelector("h3.b4-approval__title")?.textContent).toBe(
      "researcher wants to run a command",
    )
    expect(root.querySelector("p.b4-approval__reason")?.textContent).toBe(
      "It isn't on this app's allow-list.",
    )
    expect(root.querySelector("pre.b4-approval__payload")?.textContent).toBe(
      "node scripts/fetch-source.mjs https://example.org/paper",
    )
    const buttons = Array.from(root.querySelectorAll(".b4-approval__actions > button"))
    expect(buttons.map((b) => [b.className, b.textContent, b.getAttribute("type")])).toEqual([
      ["b4-approval__button b4-approval__button--primary", "Allow once", "button"],
      ["b4-approval__button b4-approval__button--secondary", "Always allow", "button"],
      ["b4-approval__button b4-approval__button--text", "Deny", "button"],
    ])
    expect(root.querySelector("p.b4-approval__scope")?.textContent).toBe(
      "“Always allow” applies to this exact command, for this app.",
    )
  })

  test("without always: no second button and no scope line", () => {
    const { root } = card(() => {}, { offersAlways: false })
    expect(root.textContent).not.toContain("Always allow")
    expect(root.querySelector(".b4-approval__scope")).toBeNull()
  })

  test("deciding disables the buttons; a rejected decision re-enables them with an inline error", async () => {
    let reject: (e: Error) => void = () => {}
    const onDecide = vi.fn(
      () =>
        new Promise<void>((_, r) => {
          reject = r
        }),
    )
    const { fixture, root, section } = card(onDecide)
    click(fixture, button(root, "Allow once"))
    expect(onDecide).toHaveBeenCalledWith("once")
    expect(section().getAttribute("data-state")).toBe("deciding")
    expect(section().getAttribute("aria-busy")).toBe("true")
    expect(button(root, "Deny")?.disabled).toBe(true)
    reject(new Error("network down"))
    await settle(fixture)
    expect(section().getAttribute("data-state")).toBe("failed")
    expect(root.querySelector(".b4-approval__error")?.textContent).toBe(
      "Couldn't send your decision: network down",
    )
    expect(button(root, "Deny")?.disabled).toBe(false)
  })

  test("Always allow and Deny dispatch their decisions", () => {
    const onDecide = vi.fn()
    const always = card(onDecide)
    click(always.fixture, button(always.root, "Always allow"))
    expect(onDecide).toHaveBeenLastCalledWith("always")
    expect(always.section().getAttribute("data-state")).toBe("deciding")
    const deny = card(onDecide)
    click(deny.fixture, button(deny.root, "Deny"))
    expect(onDecide).toHaveBeenLastCalledWith("deny")
  })

  test("a synchronous throw from onDecide lands as a failed state with the message", async () => {
    const { fixture, root, section } = card(() => {
      throw new Error("not connected")
    })
    click(fixture, button(root, "Allow once"))
    await settle(fixture)
    expect(section().getAttribute("data-state")).toBe("failed")
    expect(section().hasAttribute("aria-busy")).toBe(false)
    expect(root.querySelector(".b4-approval__error")?.textContent).toBe(
      "Couldn't send your decision: not connected",
    )
  })

  test("a resolved decision keeps the card deciding and busy until the connector replaces it", async () => {
    const { fixture, root, section } = card(() => Promise.resolve())
    click(fixture, button(root, "Allow once"))
    await settle(fixture)
    expect(section().getAttribute("data-state")).toBe("deciding")
    expect(section().getAttribute("aria-busy")).toBe("true")
    expect(button(root, "Allow once")?.disabled).toBe(true)
  })
})
