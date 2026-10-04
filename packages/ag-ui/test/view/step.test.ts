import { EventType } from "@ag-ui/core"
import { describe, expect, it } from "vitest"
import { readStepEvent } from "../../src/view/step.ts"

const custom = (name: string, value: unknown) => ({ type: EventType.CUSTOM, name, value }) as never

describe("readStepEvent", () => {
  it("returns the value of a well-formed b4.step event", () => {
    const value = { toolCallId: "t1", status: "running" }
    expect(readStepEvent(custom("b4.step", value))).toEqual(value)
  })

  it("ignores a non-CUSTOM event", () => {
    expect(readStepEvent({ type: EventType.RUN_STARTED } as never)).toBeUndefined()
  })

  it("ignores a CUSTOM event with another name", () => {
    const value = { toolCallId: "t1", status: "running" }
    expect(readStepEvent(custom("b4.content_parts_dropped", value))).toBeUndefined()
  })

  it("rejects a missing or empty toolCallId", () => {
    expect(readStepEvent(custom("b4.step", { status: "running" }))).toBeUndefined()
    expect(readStepEvent(custom("b4.step", { toolCallId: "", status: "running" }))).toBeUndefined()
  })

  it("rejects an unknown status", () => {
    expect(readStepEvent(custom("b4.step", { toolCallId: "t1", status: "weird" }))).toBeUndefined()
  })

  it("drops invalid optional fields", () => {
    const base = { toolCallId: "t1", status: "completed" }
    expect(readStepEvent(custom("b4.step", { ...base, label: 42 }))).toEqual(base)
    expect(readStepEvent(custom("b4.step", { ...base, icon: "sparkle" }))).toEqual(base)
    expect(
      readStepEvent(
        custom("b4.step", { ...base, sources: [{ title: "" }, { title: "a.md", href: 1 }, "x"] }),
      ),
    ).toEqual({ ...base, sources: [{ title: "a.md" }] })
  })
})
