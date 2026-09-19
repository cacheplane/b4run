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
    type: "permission-request",
    kind: "tool",
    grant: "b4ag_abc",
    detail: { toolName: "allocate" },
  }

  test("surfaces the grant top-level AND keeps it in metadata", () => {
    const interrupt = toAguiInterrupt(envelope)
    if (!interrupt) throw new Error("expected an interrupt")
    expect(interrupt.grant).toBe("b4ag_abc")
    // `metadata` is the copy that survives a round trip through AG-UI's own
    // `InterruptSchema`, which is a closed `"strip"`-mode object with no
    // `grant` key. Dropping this copy would make a re-validating client's
    // prompt silently unanswerable under `approvals.grants: "required"`.
    expect((interrupt.metadata as { grant?: string }).grant).toBe("b4ag_abc")
  })

  test("omits the top-level field entirely when the envelope carries no grant", () => {
    const { grant: _grant, ...withoutGrant } = envelope
    const interrupt = toAguiInterrupt(withoutGrant)
    if (!interrupt) throw new Error("expected an interrupt")
    expect(Object.hasOwn(interrupt, "grant")).toBe(false)
  })

  test("ignores a non-string grant rather than forwarding it", () => {
    const interrupt = toAguiInterrupt({ ...envelope, grant: { nope: true } })
    if (!interrupt) throw new Error("expected an interrupt")
    expect(Object.hasOwn(interrupt, "grant")).toBe(false)
  })
})

describe("fromAguiResume — approval grants", () => {
  test("echoes a string grant through to the B4 resume request", () => {
    const [resume] = fromAguiResume([
      { interruptId: "perm-1", status: "resolved", payload: "once", grant: "b4ag_abc" },
    ])
    expect(resume).toEqual({
      interruptId: "perm-1",
      status: "resolved",
      payload: "once",
      grant: "b4ag_abc",
    })
  })

  test("drops a non-string grant — an opaque echo is not a JSON channel", () => {
    const [resume] = fromAguiResume([
      { interruptId: "perm-1", status: "cancelled", grant: { evil: true } },
    ])
    if (!resume) throw new Error("expected one entry")
    expect(Object.hasOwn(resume, "grant")).toBe(false)
  })
})
