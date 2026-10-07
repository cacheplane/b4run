import { describe, expect, test } from "vitest"
import { fromAguiResume, toAguiInterrupt } from "../src/interrupts.js"

const PERMISSION_RESPONSE = { type: "string", enum: ["once", "always", "deny"] }

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
      responseSchema: PERMISSION_RESPONSE,
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
      responseSchema: PERMISSION_RESPONSE,
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
      responseSchema: PERMISSION_RESPONSE,
    })
  })

  test("maps callId to toolCallId when the envelope has no toolCallId", () => {
    const envelope = { interruptId: "perm-3", kind: "tool", callId: "call_task_0_2" }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-3",
      reason: "tool",
      toolCallId: "call_task_0_2",
      metadata: envelope,
      responseSchema: PERMISSION_RESPONSE,
    })
  })

  test("prefers an explicit toolCallId over callId when both are present", () => {
    const envelope = { interruptId: "perm-4", kind: "tool", callId: "call-a", toolCallId: "call-b" }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-4",
      reason: "tool",
      toolCallId: "call-b",
      subagentRunId: "call-a",
      metadata: envelope,
      responseSchema: PERMISSION_RESPONSE,
    })
  })

  test("a root gate carries toolCallId and no subagentRunId", () => {
    const envelope = { interruptId: "perm-7", kind: "command", toolCallId: "call-c" }
    const interrupt = toAguiInterrupt(envelope)
    expect(interrupt).toMatchObject({ toolCallId: "call-c" })
    expect(Object.hasOwn(interrupt as object, "subagentRunId")).toBe(false)
  })

  test("a subagent dispatch gate keeps callId as the toolCallId with no subagentRunId", () => {
    const envelope = { interruptId: "perm-8", kind: "subagent", callId: "call-task" }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-8",
      reason: "subagent",
      toolCallId: "call-task",
      metadata: envelope,
      responseSchema: PERMISSION_RESPONSE,
    })
  })

  test("a permission request advertises the once/always/deny answers", () => {
    const envelope = { interruptId: "perm-9", type: "permission-request", kind: "tool" }
    expect(toAguiInterrupt(envelope)).toMatchObject({
      responseSchema: PERMISSION_RESPONSE,
    })
  })

  test("equal callId and toolCallId is a dispatch gate with no subagentRunId", () => {
    const envelope = {
      interruptId: "perm-10",
      kind: "subagent",
      callId: "call-task",
      toolCallId: "call-task",
    }
    const interrupt = toAguiInterrupt(envelope)
    expect(interrupt).toMatchObject({ toolCallId: "call-task" })
    expect(Object.hasOwn(interrupt as object, "subagentRunId")).toBe(false)
  })

  test("a tool prompt with allowAlways: false offers only once and deny", () => {
    const envelope = {
      interruptId: "perm-every",
      type: "permission-request",
      kind: "tool",
      allowAlways: false,
      toolCallId: "call-file",
      detail: {
        toolName: "fileFlightPlan",
        argsPreview: "{}",
        suggestedPattern: "fileFlightPlan",
      },
    }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-every",
      reason: "tool",
      toolCallId: "call-file",
      metadata: envelope,
      responseSchema: { type: "string", enum: ["once", "deny"] },
    })
  })

  test("only allowAlways: false, exactly, drops the always answer", () => {
    const envelope = { interruptId: "perm-x", kind: "tool", allowAlways: "false" }
    expect(toAguiInterrupt(envelope)?.responseSchema).toEqual(PERMISSION_RESPONSE)
  })

  test("a non-permission interrupt has no responseSchema", () => {
    const envelope = { interruptId: "x-1", kind: "custom" }
    const interrupt = toAguiInterrupt(envelope)
    expect(Object.hasOwn(interrupt as object, "responseSchema")).toBe(false)
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
    if (!resume) throw new Error("expected one entry")
    expect(Object.hasOwn(resume, "grant")).toBe(false)
  })

  test("drops a non-string metadata grant — an opaque echo is not a JSON channel", () => {
    const [resume] = fromAguiResume([
      { interruptId: "perm-1", status: "cancelled", metadata: { grant: { evil: true } } },
    ])
    if (!resume) throw new Error("expected one entry")
    expect(Object.hasOwn(resume, "grant")).toBe(false)
  })
})
