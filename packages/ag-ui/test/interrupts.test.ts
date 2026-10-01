import { describe, expect, test } from "vitest"
import { fromAguiResume, toAguiInterrupt } from "../src/interrupts.js"

describe("toAguiInterrupt", () => {
  test("preserves a subagent permission envelope as metadata", () => {
    const envelope = {
      interruptId: "perm-1",
      type: "permission-request",
      kind: "subagent",
      callId: "task-1",
      detail: {
        parentRouteId: "/support",
        subagentName: "writer",
        subagentRouteId: "/support/subagents/writer",
        inputPreview: "Draft the response",
        reason: "Drafts require review.",
        suggestedPattern: JSON.stringify(["/support", "writer"]),
      },
    }

    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-1",
      reason: "subagent",
      toolCallId: "task-1",
      metadata: envelope,
    })
  })

  test("maps a B4.run interrupt envelope to an AG-UI Interrupt, preserving the envelope as metadata", () => {
    const envelope = {
      interruptId: "perm-1",
      kind: "command",
      type: "permission-request",
      detail: { command: "ls" },
    }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-1",
      reason: "command",
      metadata: envelope,
    })
  })

  test("carries an optional human message and toolCallId when present", () => {
    const envelope = {
      interruptId: "perm-2",
      kind: "tool",
      message: "Approve?",
      toolCallId: "tc-9",
    }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-2",
      reason: "tool",
      message: "Approve?",
      toolCallId: "tc-9",
      metadata: envelope,
    })
  })

  test("maps callId to toolCallId when the envelope has no toolCallId", () => {
    const envelope = { interruptId: "perm-3", kind: "tool", callId: "call_task_0_2" }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-3",
      reason: "tool",
      toolCallId: "call_task_0_2",
      metadata: envelope,
    })
  })

  test("prefers an explicit toolCallId over callId when both are present", () => {
    const envelope = { interruptId: "perm-4", kind: "tool", callId: "call-a", toolCallId: "call-b" }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-4",
      reason: "tool",
      toolCallId: "call-b",
      metadata: envelope,
    })
  })

  test("omits toolCallId when neither callId nor toolCallId is present", () => {
    const envelope = { interruptId: "perm-5", kind: "tool" }
    const interrupt = toAguiInterrupt(envelope)
    expect(Object.hasOwn(interrupt as object, "toolCallId")).toBe(false)
  })

  test("omits toolCallId when callId and toolCallId are both empty strings", () => {
    const envelope = { interruptId: "perm-6", kind: "tool", callId: "", toolCallId: "" }
    const interrupt = toAguiInterrupt(envelope)
    expect(Object.hasOwn(interrupt as object, "toolCallId")).toBe(false)
  })

  test("rejects a malformed envelope instead of synthesizing an interrupt id", () => {
    expect(toAguiInterrupt(null)).toBeNull()
  })

  test("treats arrays as malformed envelopes", () => {
    expect(toAguiInterrupt([])).toBeNull()
  })

  test("treats non-plain objects as malformed envelopes", () => {
    expect(toAguiInterrupt(new Date(0))).toBeNull()
  })

  test("treats plain objects without a non-empty string interruptId as malformed envelopes", () => {
    expect(toAguiInterrupt({ foo: "bar" })).toBeNull()
    expect(toAguiInterrupt({ interruptId: 123, kind: "command" })).toBeNull()
    expect(toAguiInterrupt({ interruptId: "", kind: "command" })).toBeNull()
  })
})

describe("fromAguiResume", () => {
  test("maps AG-UI resume entries to B4.run resume requests, preserving interruptId", () => {
    expect(
      fromAguiResume([
        { interruptId: "perm-1", status: "resolved", payload: "once" },
        { interruptId: "perm-2", status: "cancelled" },
      ]),
    ).toEqual([
      { interruptId: "perm-1", status: "resolved", payload: "once" },
      { interruptId: "perm-2", status: "cancelled" },
    ])
  })

  test("preserves a present payload key with an undefined value", () => {
    const [resume] = fromAguiResume([
      { interruptId: "perm-1", status: "resolved", payload: undefined },
    ])
    if (!resume) throw new Error("expected fromAguiResume to return one entry")
    expect(resume).toEqual({ interruptId: "perm-1", status: "resolved", payload: undefined })
    expect(Object.hasOwn(resume, "payload")).toBe(true)
  })
})

describe("toAguiInterrupt — approval grants", () => {
  const envelope = {
    interruptId: "perm-1",
    kind: "tool",
    callId: "call_deploy_0_0",
    grant: "b4ag_abc",
  }

  test("keeps the grant in metadata only: the top-level field is one 1.0 clients strip", () => {
    const interrupt = toAguiInterrupt(envelope)
    if (interrupt === null) throw new Error("expected an interrupt")
    expect(Object.hasOwn(interrupt, "grant")).toBe(false)
    expect((interrupt.metadata as { grant?: string }).grant).toBe("b4ag_abc")
  })
})

describe("fromAguiResume — approval grants", () => {
  test("reads the grant from the entry's metadata", () => {
    const [resume] = fromAguiResume([
      {
        interruptId: "perm-1",
        status: "resolved",
        payload: "once",
        metadata: { grant: "b4ag_abc" },
      },
    ])
    expect(resume).toEqual({
      interruptId: "perm-1",
      status: "resolved",
      payload: "once",
      grant: "b4ag_abc",
    })
  })

  test("does not read a top-level grant: a 1.0 client never sends one", () => {
    const [resume] = fromAguiResume([
      { interruptId: "perm-1", status: "resolved", payload: "once", grant: "b4ag_abc" } as never,
    ])
    expect(Object.hasOwn(resume as object, "grant")).toBe(false)
  })

  test("drops a non-string metadata grant — an opaque echo is not a JSON channel", () => {
    const [resume] = fromAguiResume([
      { interruptId: "perm-1", status: "cancelled", metadata: { grant: { evil: true } } },
    ])
    expect(Object.hasOwn(resume as object, "grant")).toBe(false)
  })
})
