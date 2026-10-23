import { EventType } from "@ag-ui/core"
import { expect, test } from "vitest"
import { eventsFromState, turnsFromState } from "../../src/view/turns-from-state.ts"
import { ai, base, ckpt, human, T0, toolMsg } from "./state-fixtures.ts"

for (const status of ["completed", "failed", "denied", "cancelled"] as const) {
  test(`restores a v1 ${status} step on the result and turns with its full contract`, () => {
    const stamp = {
      v: 1,
      kind: "provider",
      builtin: "web_search",
      provider: "openai",
      status,
      label: "Searched weather",
      queries: ["KSFO weather"],
      sources: [{ id: "weather", kind: "url", title: "Weather", href: "https://test.example" }],
      startedAt: T0 + 1500,
      settledAt: T0 + 2500,
      decision: status === "denied" ? "deny" : "once",
      ...(status === "failed" ? { error: { message: "Search unavailable", code: "SEARCH" } } : {}),
    }
    const call = { id: "c1", name: "web_search", args: {} }
    const messages = [
      human("u1", "weather"),
      ai("a1", "", [call]),
      toolMsg("c1", "web_search", "result", stamp),
    ]
    const input = base([
      ckpt("k0", 0, messages.slice(0, 1)),
      ckpt("k1", 1, messages.slice(0, 2)),
      ckpt("k2", 3, messages),
    ])

    const { events, warnings } = eventsFromState(input)
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
    const { turns } = turnsFromState(input)

    expect(warnings).toEqual([])
    expect(result).toMatchObject({ metadata: { "b4.step": stamp }, timestamp: T0 + 2500 })
    expect(
      (result as unknown as { metadata: { "b4.step": object } }).metadata["b4.step"],
    ).not.toHaveProperty("toolCallId")
    if (status === "failed") expect(result).toHaveProperty("error", "Search unavailable")
    expect(turns.turns[0]?.steps[0]).toMatchObject({
      status: status === "completed" ? "done" : status,
      startedAt: T0 + 1500,
      settledAt: T0 + 2500,
      sources: stamp.sources,
      decision: stamp.decision,
    })
  })
}

test("reads stored ToolMessage.error as a failed result", () => {
  const call = { id: "c1", name: "run", args: {} }
  const message = toolMsg("c1", "run", "failure text", {
    v: 1,
    kind: "server",
    status: "completed",
  })
  const input = base([
    ckpt("k0", 0, [
      human("u1", "go"),
      ai("a1", "", [call]),
      { ...message, kwargs: { ...message.kwargs, error: "Stored failure" } },
    ]),
  ])

  const { events } = eventsFromState(input)

  expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
    error: "Stored failure",
    metadata: { "b4.step": { status: "failed", error: { message: "Stored failure" } } },
  })
})

test("normalizes legacy ISO clocks and source ids on replay results", () => {
  const call = { id: "legacy", name: "search", args: {} }
  const messages = [
    human("u1", "go"),
    ai("a1", "", [call]),
    toolMsg("legacy", "search", "hit", {
      status: "completed",
      startedAt: new Date(T0 + 1000).toISOString(),
      settledAt: new Date(T0 + 2000).toISOString(),
      sources: [{ title: "Hit", href: "https://test.example" }],
    }),
  ]

  const { events } = eventsFromState(base([ckpt("k0", 0, messages)]))

  expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
    metadata: {
      "b4.step": {
        v: 1,
        kind: "server",
        status: "completed",
        startedAt: T0 + 1000,
        settledAt: T0 + 2000,
        sources: [{ id: "legacy:0", kind: "url", title: "Hit", href: "https://test.example" }],
      },
    },
  })
})

test("clamps v1 clocks before the announcing checkpoint in metadata and turns", () => {
  const call = { id: "c1", name: "run", args: {} }
  const messages = [
    human("u1", "go"),
    ai("a1", "", [call]),
    toolMsg("c1", "run", "ok", {
      v: 1,
      kind: "server",
      status: "completed",
      startedAt: T0 - 1000,
      settledAt: T0 - 2000,
    }),
  ]
  const input = base([ckpt("k0", 0, messages.slice(0, 1)), ckpt("k1", 1, messages)])

  const { events, warnings } = eventsFromState(input)

  expect(warnings).toEqual([
    "clamped b4_step clocks on tool call c1 to the checkpoint that announced it",
  ])
  expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
    timestamp: T0 + 1000,
    metadata: { "b4.step": { startedAt: T0 + 1000, settledAt: T0 + 1000 } },
  })
  expect(turnsFromState(input).turns.turns[0]?.steps[0]).toMatchObject({
    startedAt: T0 + 1000,
    settledAt: T0 + 1000,
  })
})

test("restores status-error ToolMessages without a stamp as a failed metadata result", () => {
  const call = { id: "c1", name: "run", args: {} }
  const message = toolMsg("c1", "run", "Execution failed", {}, {}, "error")
  const input = base([ckpt("k0", 0, [human("u1", "go"), ai("a1", "", [call]), message])])

  const { events } = eventsFromState(input)

  expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
    content: "Execution failed",
    error: "Execution failed",
    metadata: {
      "b4.step": { v: 1, kind: "server", status: "failed", error: { message: "Execution failed" } },
    },
  })
})

for (const status of ["completed", "failed"] as const) {
  test(`a ${status} step without settledAt uses the result checkpoint time`, () => {
    const call = { id: "c1", name: "run", args: {} }
    const messages = [
      human("u1", "go"),
      ai("a1", "", [call]),
      toolMsg("c1", "run", "result", {
        v: 1,
        kind: "server",
        status,
        startedAt: T0 + 1000,
      }),
    ]
    const input = base([
      ckpt("k0", 0, messages.slice(0, 1)),
      ckpt("k1", 1, messages.slice(0, 2)),
      ckpt("k2", 3, messages),
    ])

    const { events } = eventsFromState(input)

    expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)?.timestamp).toBe(
      T0 + 3000,
    )
    expect(turnsFromState(input).turns.turns[0]?.steps[0]).toMatchObject({
      startedAt: T0 + 1000,
      settledAt: T0 + 3000,
    })
  })
}
