import { describe, expect, it } from "vitest"
import {
  B4_ANSWER_JSON_SCHEMA,
  B4_TOOL_STEP_JSON_SCHEMA,
  type B4ToolStep,
  mergeToolStep,
  readAnswerAnnotations,
  readToolStep,
  readToolStepUpdate,
  settleOpenSteps,
} from "../src/tool-step.ts"

type Schema = {
  required?: readonly string[]
  properties?: Record<string, { enum?: readonly unknown[]; const?: unknown; [k: string]: unknown }>
}

function accepts(schema: Schema, value: Record<string, unknown>): boolean {
  for (const key of schema.required ?? []) if (!(key in value)) return false
  for (const [key, rule] of Object.entries(schema.properties ?? {})) {
    if (rule.enum && key in value && !rule.enum.includes(value[key])) return false
  }
  return true
}

const running = (extra: Partial<B4ToolStep> = {}): B4ToolStep => ({
  v: 1,
  toolCallId: "c1",
  kind: "server",
  status: "running",
  ...extra,
})

describe("readToolStep", () => {
  it("normalizes a legacy CUSTOM value", () => {
    const step = readToolStep({
      toolCallId: "c1",
      status: "completed",
      label: "Fetched",
      sources: [{ title: "A", href: "https://a" }],
    })

    expect(step).toEqual({
      v: 1,
      toolCallId: "c1",
      kind: "server",
      status: "completed",
      label: "Fetched",
      sources: [{ id: "c1:0", kind: "url", title: "A", href: "https://a" }],
    })
    expect(accepts(B4_TOOL_STEP_JSON_SCHEMA, step as never)).toBe(true)
  })

  it("gives hrefless legacy sources the record kind and uses the fallback id", () => {
    const step = readToolStep({ status: "completed", sources: [{ title: "Row" }] }, "c9")

    expect(step?.toolCallId).toBe("c9")
    expect(step?.sources).toEqual([{ id: "c9:0", kind: "record", title: "Row" }])
    expect(accepts(B4_TOOL_STEP_JSON_SCHEMA, step as never)).toBe(true)
  })

  it("reads a legacy PersistedStep's ISO times as epoch ms", () => {
    const step = readToolStep({
      status: "completed",
      startedAt: "2026-10-21T00:00:00.000Z",
      settledAt: "2026-10-21T00:00:01.000Z",
      decision: "once",
    })

    expect(step?.startedAt).toBe(1792540800000)
    expect(step?.settledAt).toBe(1792540801000)
    expect(step?.decision).toBe("once")
    expect(accepts(B4_TOOL_STEP_JSON_SCHEMA, step as never)).toBe(true)
  })

  it("cuts a 130-character label to 120", () => {
    const step = readToolStep({ status: "running", label: "x".repeat(130) })

    expect(step?.label).toHaveLength(120)
    expect(accepts(B4_TOOL_STEP_JSON_SCHEMA, step as never)).toBe(true)
  })

  it("leaves status out for an unknown status string", () => {
    const step = readToolStep({ v: 1, kind: "server", status: "exploded" })

    expect(step).toBeDefined()
    expect(step?.status).toBeUndefined()
  })

  it("returns undefined for non-records and a missing status", () => {
    expect(readToolStep("x")).toBeUndefined()
    expect(readToolStep(null)).toBeUndefined()
    expect(readToolStep([])).toBeUndefined()
    expect(readToolStep({ v: 1, kind: "server" })).toBeUndefined()
  })

  it("passes unknown icons and open strings through", () => {
    const step = readToolStep({
      v: 1,
      kind: "provider",
      status: "running",
      icon: "rocket",
      builtin: "x_search",
    })

    expect(step).toMatchObject({ kind: "provider", icon: "rocket", builtin: "x_search" })
    expect(accepts(B4_TOOL_STEP_JSON_SCHEMA, step as never)).toBe(true)
  })

  it("drops error unless the step failed", () => {
    expect(readToolStep({ status: "running", error: { message: "no" } })?.error).toBeUndefined()
    expect(readToolStep({ status: "failed", error: { message: "no", code: "E" } })?.error).toEqual({
      message: "no",
      code: "E",
    })
  })
})

describe("mergeToolStep", () => {
  it("keeps failed over a later completed message", () => {
    const failed = running({ status: "failed", error: { message: "x" } })

    expect(mergeToolStep(failed, running({ status: "completed" }), "message").status).toBe("failed")
  })

  it("clears label and sources when a call is denied", () => {
    const previous = running({
      label: "Working",
      sources: [{ id: "c1:0", kind: "url", title: "A" }],
    })

    const next = mergeToolStep(previous, running({ status: "denied" }), "call")

    expect(next.status).toBe("denied")
    expect(next).not.toHaveProperty("label")
    expect(next).not.toHaveProperty("sources")
  })

  it("does not lift a settled step back to running", () => {
    const done = running({ status: "completed" })

    expect(mergeToolStep(done, running(), "call").status).toBe("completed")
    expect(mergeToolStep(done, running(), "message").status).toBe("completed")
  })

  it("lets the message beat the call", () => {
    const fromCall = running({ status: "completed", label: "Call label" })

    const merged = mergeToolStep(
      fromCall,
      running({ status: "completed", label: "Message label" }),
      "message",
    )
    const kept = mergeToolStep(fromCall, running({ status: "completed", label: "Other" }), "call")

    expect(merged.label).toBe("Message label")
    expect(kept.label).toBe("Call label")
  })

  it("never changes status for a read without one", () => {
    const read = readToolStep({ v: 1, kind: "server", status: "exploded", label: "L" })

    const merged = mergeToolStep(running({ status: "completed" }), read as never, "message")

    expect(merged.status).toBe("completed")
    expect(merged.label).toBe("L")
  })

  it("keeps a settled step's label when a later call has none", () => {
    const denied = running({ status: "denied", label: "Denied by user" })

    const merged = mergeToolStep(denied, running({ status: "denied" }), "call")

    expect(merged.label).toBe("Denied by user")
  })

  it("drops what a completed step showed when it then fails, taking next's fields", () => {
    const done = running({
      status: "completed",
      label: "Searched",
      icon: "search",
      sources: [{ id: "c1:0", kind: "record", title: "A" }],
    })

    const failed = mergeToolStep(
      done,
      running({ status: "failed", label: "Search failed", icon: "alert" }),
      "call",
    )
    const bare = mergeToolStep(done, running({ status: "failed" }), "call")

    expect(failed).toMatchObject({ status: "failed", label: "Search failed", icon: "alert" })
    expect(failed).not.toHaveProperty("sources")
    expect(failed.error).toEqual({ message: "Tool call did not finish" })
    expect(bare).not.toHaveProperty("label")
    expect(bare).not.toHaveProperty("sources")
    expect(bare.icon).toBe("search")
  })

  it("keeps the stored provider kind against a sparse legacy value", () => {
    const stored = running({ kind: "provider", builtin: "web_search" })

    const merged = mergeToolStep(
      stored,
      readToolStepUpdate({ toolCallId: "c1", status: "completed" }) as never,
      "message",
    )

    expect(merged.kind).toBe("provider")
    expect(merged.status).toBe("completed")
  })

  it("gives a failed step without an error the default one", () => {
    const merged = mergeToolStep(running(), running({ status: "failed" }), "call")

    expect(merged.error).toEqual({ message: "Tool call did not finish" })
  })

  it("drops the running label and sources on a settle that restates neither", () => {
    const previous = running({
      label: "Searching",
      icon: "search",
      queries: ["q"],
      sources: [{ id: "c1:0", kind: "record", title: "A" }],
      startedAt: 1,
    })

    const bare = mergeToolStep(previous, running({ status: "completed", settledAt: 2 }), "call")
    const restated = mergeToolStep(
      previous,
      running({
        status: "completed",
        label: "Searched",
        sources: [{ id: "c1:1", kind: "record", title: "B" }],
      }),
      "call",
    )

    expect(bare).toEqual({
      v: 1,
      toolCallId: "c1",
      kind: "server",
      status: "completed",
      icon: "search",
      queries: ["q"],
      startedAt: 1,
      settledAt: 2,
    })
    expect(restated.label).toBe("Searched")
    expect(restated.sources).toEqual([{ id: "c1:1", kind: "record", title: "B" }])
  })

  it("takes no fields from a running write once the step has settled", () => {
    const done = running({ status: "completed", label: "Done" })
    const late = running({ label: "Late", icon: "mail", queries: ["q"], startedAt: 9 })

    expect(mergeToolStep(done, late, "call")).toEqual(done)
    expect(mergeToolStep(done, late, "message")).toEqual(done)
  })

  it("lets a different bad status from the call replace a completed step", () => {
    const done = running({ status: "completed", label: "Refunded" })

    const denied = mergeToolStep(
      done,
      running({ status: "denied", label: "Blocked", decision: "deny" }),
      "call",
    )

    expect(denied).toMatchObject({ status: "denied", label: "Blocked", decision: "deny" })
  })

  it("starts from next when there is no previous step", () => {
    expect(mergeToolStep(undefined, running(), "call")).toEqual(running())
  })
})

describe("settleOpenSteps", () => {
  it("settles running steps except the ones kept open", () => {
    const steps = { a: running({ label: "A" }), b: running(), c: running({ status: "completed" }) }

    const settled = settleOpenSteps(steps, "cancelled", new Set(["b"]), 5)

    expect(settled.a).toMatchObject({ status: "cancelled", settledAt: 5 })
    expect(settled.a).not.toHaveProperty("label")
    expect(settled.b?.status).toBe("running")
    expect(settled.c?.status).toBe("completed")
    expect(steps.a?.status).toBe("running")
  })

  it("gives a failed step an error", () => {
    const settled = settleOpenSteps({ a: running() }, "failed", new Set(), 7)

    expect(settled.a?.error?.message).toBeTruthy()
  })
})

describe("readAnswerAnnotations", () => {
  it("reads citations, sources and attribution", () => {
    const value = readAnswerAnnotations({
      v: 1,
      citations: [{ sourceId: "s1", quote: "q", block: 0 }, { quote: "no id" }],
      sources: [{ id: "s1", kind: "url", title: "T", href: "https://t" }],
      attribution: [{ provider: "google", kind: "maps", html: "<p/>" }],
    })

    expect(value?.citations).toEqual([{ sourceId: "s1", quote: "q", block: 0 }])
    expect(value?.sources?.[0]?.id).toBe("s1")
    expect(value?.attribution?.[0]).toMatchObject({ provider: "google", mustRender: true })
    expect(accepts(B4_ANSWER_JSON_SCHEMA, value as never)).toBe(true)
  })

  it("returns undefined for non-records and other versions", () => {
    expect(readAnswerAnnotations(3)).toBeUndefined()
    expect(readAnswerAnnotations({ v: 2 })).toBeUndefined()
  })
})
