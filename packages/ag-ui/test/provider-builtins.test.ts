import { enforceEvents, verifyEvents } from "@ag-ui/client"
import { EventType } from "@ag-ui/core"
import { type B4AnswerAnnotations, normalizeProviderMessage } from "@b4run/sdk"
import { TOOL_STEP_FIXTURES } from "@b4run/sdk/testing"
import { from, lastValueFrom, toArray } from "rxjs"
import { expect, test } from "vitest"
import { fromRunAgentInput } from "../src/inbound.js"
import { toAguiEvents } from "../src/outbound.js"
import type { B4AgentStreamChunk } from "../src/types.js"
import { EMPTY_TURNS, reduceTurns } from "../src/view/turns.js"
import { eventsFromState, turnsFromState } from "../src/view/turns-from-state.js"
import { base, ckpt, env, human, T0 } from "./view/state-fixtures.js"

async function collect(chunks: B4AgentStreamChunk[]) {
  async function* stream() {
    yield* chunks
  }
  const events = []
  for await (const event of toAguiEvents(stream(), { threadId: "t", runId: "r" }))
    events.push(event)
  return events
}

const answer: B4AnswerAnnotations = {
  v: 1,
  sources: [{ id: "source", title: "Example", kind: "url", href: "https://example.com" }],
  attribution: [
    {
      provider: "google",
      kind: "search-suggestions",
      html: '<div data-x="1">Search <b>Suggestions</b></div>',
      mustRender: true,
    },
  ],
}

test("provider result carries authoritative failure separately from readable output", async () => {
  const step = {
    v: 1,
    kind: "provider",
    provider: "openai",
    builtin: "code_execution",
    status: "failed",
    error: { message: "Code failed", code: "incomplete" },
  } as const

  const events = await collect([
    { type: "tool_call", data: { id: "c", name: "code_execution", input: {} } },
    {
      type: "tool_result",
      data: { id: "c", name: "code_execution", output: "division by zero", step },
    },
  ])

  expect(events.find((e) => e.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
    content: "division by zero",
    error: "Code failed",
    metadata: { "b4.step": step },
  })
})

test("answer annotations end their own message and annotation-only owners keep no visible prose", async () => {
  const events = await collect([
    { type: "token", data: "hello", messageId: "a" },
    { type: "message_annotations", data: { messageId: "a", answer } },
    { type: "message_end", data: { messageId: "a" } },
    { type: "message_annotations", data: { messageId: "b", answer } },
    { type: "message_end", data: { messageId: "b" } },
  ])
  const ends = events.filter((e) => e.type === EventType.TEXT_MESSAGE_END)
  const view = events.reduce((v, e) => reduceTurns(v, e), EMPTY_TURNS)

  expect(ends).toHaveLength(2)
  expect(ends).toEqual(
    expect.arrayContaining([expect.objectContaining({ metadata: { "b4.answer": answer } })]),
  )
  expect(view.turns[0]?.text).toBe("hello")
  expect(Object.values(view.turns[0]?.answers ?? {})).toEqual([answer, answer])
  expect(events.some((e) => e.type === EventType.TOOL_CALL_START)).toBe(false)
})

test("restore normalizes native provider history and answer annotations with canonical identities", () => {
  const kwargs = {
    id: "canonical",
    content: "hello",
    response_metadata: {
      output: [
        {
          type: "web_search_call",
          id: "s",
          status: "completed",
          action: { sources: [{ url: "https://example.com", title: "Example" }] },
        },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "hello",
              annotations: [
                { type: "url_citation", url: "https://example.com", start_index: 0, end_index: 5 },
              ],
            },
          ],
        },
      ],
    },
  }
  const input = base([ckpt("k", 1, [human("u", "query"), env("AIMessage", kwargs)])])
  const normalized = normalizeProviderMessage(kwargs, { messageId: "canonical" })

  const { turns, warnings } = turnsFromState(input)
  const { events } = eventsFromState(input)

  expect(warnings).toEqual([])
  expect(turns.turns[0]?.steps).toEqual([
    expect.objectContaining({
      id: "s",
      status: "done",
      sources: normalized.calls[0]?.step.sources,
    }),
  ])
  expect(turns.turns[0]?.answers).toEqual({ canonical: normalized.answer })
  expect(events.find((e) => e.type === EventType.TOOL_CALL_START)).toMatchObject({
    parentMessageId: "canonical",
    metadata: { "b4.step": normalized.calls[0]?.step },
  })
})

test("call-less grounding restores verbatim attribution without an empty bubble or invented call", () => {
  const input = base([
    ckpt("k", 1, [
      human("u", "query"),
      env("AIMessage", { id: "grounded", content: "", additional_kwargs: { b4_answer: answer } }),
    ]),
  ])

  const { turns } = turnsFromState(input)

  expect(turns.turns[0]?.steps).toEqual([])
  expect(turns.turns[0]?.text).toBe("")
  expect(turns.turns[0]?.answers).toEqual({ grounded: answer })
})

test("stored provider steps preserve clocks, running state, failures and deduplicate ordinary ids", () => {
  const steps = {
    running: {
      v: 1,
      kind: "provider",
      provider: "openai",
      builtin: "web_search",
      status: "running",
      startedAt: T0 + 1000,
    },
    failed: {
      v: 1,
      kind: "provider",
      provider: "openai",
      builtin: "code_execution",
      status: "failed",
      startedAt: T0 + 2000,
      settledAt: T0 + 3000,
      error: { message: "native failure" },
    },
  }
  const input = base([
    ckpt("k", 1, [
      human("u", "query"),
      env("AIMessage", {
        id: "saved",
        content: "",
        additional_kwargs: { b4_steps: steps },
        tool_calls: [{ id: "running", name: "duplicate", args: {} }],
      }),
    ]),
  ])

  const { events } = eventsFromState(input)
  const { turns } = turnsFromState(input)

  expect(events.filter((e) => e.type === EventType.TOOL_CALL_START)).toHaveLength(2)
  expect(turns.turns[0]?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "running", status: "running", startedAt: T0 + 1000 }),
      expect.objectContaining({
        id: "failed",
        status: "failed",
        startedAt: T0 + 2000,
        settledAt: T0 + 3000,
      }),
    ]),
  )
  expect(events.filter((e) => e.type === EventType.CUSTOM)).toEqual([])
})

test("annotation-only nested owners stay isolated even when their producer ids collide", async () => {
  const events = await collect([
    { type: "subagent.start", data: { call_id: "child", subagent: "researcher", depth: 1 } },
    {
      type: "subagent.start",
      data: { call_id: "grandchild", parent_call_id: "child", subagent: "researcher", depth: 2 },
    },
    { type: "message_annotations", data: { messageId: "same", answer: { v: 1 } } },
    {
      type: "subagent.message_annotations",
      data: { call_id: "grandchild", messageId: "same", answer },
    },
    { type: "subagent.message_end", data: { call_id: "grandchild", messageId: "same" } },
    { type: "message_end", data: { messageId: "same" } },
  ])
  const view = events.reduce((v, e) => reduceTurns(v, e), EMPTY_TURNS)
  const child = view.turns[0]?.steps.find((s) => s.kind === "subagent")
  const grandchild =
    child?.kind === "subagent" ? child.turn.steps.find((s) => s.kind === "subagent") : undefined

  expect(Object.values(view.turns[0]?.answers ?? {})).toEqual([{ v: 1 }])
  expect(
    grandchild?.kind === "subagent" ? Object.values(grandchild.turn.answers ?? {}) : [],
  ).toEqual([answer])
  expect(grandchild?.kind === "subagent" ? grandchild.turn.text : undefined).toBe("")
})

test("annotation-only and tool-interleaved text pass the real AG-UI 1.0 enforcer", async () => {
  const events = await collect([
    { type: "token", data: "hello", messageId: "a" },
    { type: "tool_call", data: { id: "call", name: "web_search", input: {}, messageId: "a" } },
    { type: "message_annotations", data: { messageId: "a", answer } },
    { type: "message_end", data: { messageId: "a" } },
    { type: "message_annotations", data: { messageId: "b", answer } },
    { type: "message_end", data: { messageId: "b" } },
  ])

  const enforced = await lastValueFrom(
    from(events).pipe(enforceEvents(), verifyEvents(), toArray()),
  )

  expect(enforced).toEqual(events)
  expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_START)).toHaveLength(2)
})

test("late annotations after an explicit message end never invent an empty citation owner", async () => {
  const events = await collect([
    { type: "token", data: "hello", messageId: "closed" },
    { type: "message_end", data: { messageId: "closed" } },
    { type: "message_annotations", data: { messageId: "closed", answer } },
  ])

  expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_START)).toHaveLength(1)
  expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_END)).toHaveLength(1)
})

for (const fixture of TOOL_STEP_FIXTURES) {
  test(`actual activity view preserves message-local answers from SDK fixture ${fixture.name}`, () => {
    const start = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" }

    const view = [start, ...fixture.events].reduce(
      (v, event) => reduceTurns(v, event as import("@ag-ui/core").BaseEvent),
      EMPTY_TURNS,
    )

    expect(view.turns[0]?.answers).toEqual(fixture.expected.answers)
  })
}

test("restore carries failed provider results as readable errors and leaves unresolved calls without results", () => {
  const input = base([
    ckpt("k", 1, [
      human("u", "query"),
      env("AIMessage", {
        id: "failed-native",
        content: [
          { type: "server_tool_use", id: "s", name: "web_search", input: { query: "q" } },
          {
            type: "web_search_tool_result",
            tool_use_id: "s",
            content: { type: "web_search_tool_result_error", error_code: "rate_limit_exceeded" },
          },
          { executableCode: { code: "wait()" } },
        ],
      }),
    ]),
  ])

  const { events } = eventsFromState(input)

  expect(events.filter((e) => e.type === EventType.TOOL_CALL_RESULT)).toEqual([
    expect.objectContaining({
      toolCallId: "s",
      content: expect.any(String),
      error: expect.stringContaining("rate_limit_exceeded"),
      metadata: { "b4.step": expect.objectContaining({ status: "failed", kind: "provider" }) },
    }),
  ])
})

test("inbound filtering retains only ordinary history after real provider normalization", () => {
  const normalized = normalizeProviderMessage(
    {
      response_metadata: {
        output: [
          {
            type: "web_search_call",
            id: "native",
            status: "completed",
            action: { query: "weather" },
          },
        ],
      },
    },
    { messageId: "canonical" },
  )
  const call = normalized.calls[0]
  if (!call) throw new Error("expected normalized provider call")
  const metadata = { "b4.step": call.step }
  const input = {
    threadId: "t",
    runId: "r",
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
    messages: [
      {
        id: "a",
        role: "assistant",
        content: "answer",
        toolCalls: [
          {
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) },
            metadata,
          },
          { id: "app", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
      {
        id: "provider-result",
        role: "tool",
        toolCallId: call.id,
        content: call.result ?? "",
        metadata,
      },
      { id: "app-result", role: "tool", toolCallId: "app", content: "ordinary result" },
    ],
  } as import("@ag-ui/core").RunAgentInput

  const result = fromRunAgentInput(input)

  expect(result.messages).toEqual([
    { id: "a", role: "assistant", content: "answer" },
    { id: "app-result", role: "tool", toolCallId: "app", content: "ordinary result" },
  ])
})

for (const status of ["completed", "running"] as const) {
  test(`an error ToolMessage overrides an explicit ${status} result step`, async () => {
    const step = { v: 1, kind: "server", status, label: "Read file" } as const
    const output = { tool_call_id: "c", status: "error", error: "boom", content: "boom" }

    const events = await collect([
      { type: "tool_call", data: { id: "c", name: "read", input: {} } },
      { type: "tool_result", data: { id: "c", name: "read", output, step } },
    ])
    const view = events.reduce((state, event) => reduceTurns(state, event), EMPTY_TURNS)

    expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
      content: "boom",
      error: "boom",
      metadata: {
        "b4.step": { v: 1, kind: "server", status: "failed", error: { message: "boom" } },
      },
    })
    expect(view.turns[0]?.steps).toEqual([
      expect.objectContaining({ id: "c", status: "failed", error: { message: "boom" } }),
    ])
  })
}
