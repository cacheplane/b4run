import { describe, expect, test } from "vitest"
import { fromAguiResume } from "../../src/interrupts.ts"
import { approvalFromInterrupt } from "../../src/view/activity-lookup.ts"
import { toResumeEntries } from "../../src/view/resume.ts"

const gate = (id: string, grant?: string) => ({
  id,
  reason: "tool",
  metadata: { kind: "tool", ...(grant !== undefined ? { grant } : {}) },
})

describe("toResumeEntries", () => {
  test("once/always resolve with the decision, deny cancels without a payload, grants ride in metadata", () => {
    const result = toResumeEntries(
      [
        { interruptId: "i1", decision: "once" },
        { interruptId: "i2", decision: "always" },
        { interruptId: "i3", decision: "deny" },
      ],
      [gate("i1", "g1"), gate("i2"), gate("i3", "g3")],
    )
    expect(result).toEqual({
      ok: true,
      entries: [
        { interruptId: "i1", status: "resolved", payload: "once", metadata: { grant: "g1" } },
        { interruptId: "i2", status: "resolved", payload: "always" },
        { interruptId: "i3", status: "cancelled", metadata: { grant: "g3" } },
      ],
    })
  })

  test("the entries are what B4.run's resume parser reads back: decision and grant intact", () => {
    const result = toResumeEntries(
      [
        { interruptId: "i1", decision: "always" },
        { interruptId: "i2", decision: "deny" },
      ],
      [gate("i1", "g1"), gate("i2", "g2")],
    )
    if (!result.ok) throw new Error("expected entries")
    expect(fromAguiResume(result.entries)).toEqual([
      { interruptId: "i1", status: "resolved", payload: "always", grant: "g1" },
      { interruptId: "i2", status: "cancelled", grant: "g2" },
    ])
  })

  test("accepts approval views (pendingApprovals' cards) as the parked set", () => {
    const views = [approvalFromInterrupt(gate("i1", "g1")), approvalFromInterrupt(gate("i2"))]
    expect(
      toResumeEntries(
        [
          { interruptId: "i2", decision: "deny" },
          { interruptId: "i1", decision: "once" },
        ],
        views,
      ),
    ).toEqual({
      ok: true,
      entries: [
        { interruptId: "i1", status: "resolved", payload: "once", metadata: { grant: "g1" } },
        { interruptId: "i2", status: "cancelled" },
      ],
    })
  })

  test("undecided until every parked interrupt has a decision", () => {
    expect(
      toResumeEntries([{ interruptId: "i1", decision: "once" }], [gate("i1"), gate("i2")]),
    ).toEqual({ ok: false, reason: "undecided", interruptIds: ["i2"] })
  })

  test("a decision for an interrupt that is not parked is refused", () => {
    expect(
      toResumeEntries(
        [
          { interruptId: "i1", decision: "once" },
          { interruptId: "old", decision: "once" },
        ],
        [gate("i1")],
      ),
    ).toEqual({ ok: false, reason: "unknown_interrupt", interruptIds: ["old"] })
  })

  test("nothing parked: nothing to resume", () => {
    expect(toResumeEntries([], [])).toEqual({
      ok: false,
      reason: "no_interrupts",
      interruptIds: [],
    })
  })

  test("a later decision for the same interrupt replaces the earlier one", () => {
    expect(
      toResumeEntries(
        [
          { interruptId: "i1", decision: "once" },
          { interruptId: "i1", decision: "deny" },
        ],
        [gate("i1")],
      ),
    ).toEqual({ ok: true, entries: [{ interruptId: "i1", status: "cancelled" }] })
  })
})
