import { type BaseEvent, EventType } from "@ag-ui/core"
import { B4_STEP_METADATA_KEY, type B4ToolStep } from "@b4run/sdk"
import { foldToolStepEvents } from "@b4run/sdk/testing"
import { expect, test } from "vitest"
import { type AguiOutboundEvent, toAguiEvents } from "../src/outbound.ts"
import type { B4AgentStreamChunk } from "../src/types.ts"
import { EMPTY_TURNS, reduceTurns } from "../src/view/turns.ts"

async function collect(chunks: readonly B4AgentStreamChunk[]) {
  async function* source() {
    yield* chunks
  }
  const events = []
  for await (const event of toAguiEvents(source(), { threadId: "thread", runId: "run" }))
    events.push(event)
  return events
}

/** Project only fields the reference fold reads; AG-UI also permits rich content. */
function foldSteps(events: readonly AguiOutboundEvent[]) {
  return foldToolStepEvents(
    events.map((event) => ({
      type: event.type,
      ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
      ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
      ...("toolCallId" in event && event.toolCallId !== undefined
        ? { toolCallId: event.toolCallId }
        : {}),
      ...(event.type === EventType.CUSTOM ? { name: event.name, value: event.value } : {}),
      ...(event.type === EventType.RUN_FINISHED && event.outcome !== undefined
        ? { outcome: event.outcome }
        : {}),
      ...("error" in event && typeof event.error === "string" ? { error: event.error } : {}),
    })),
  )
}

const running: B4ToolStep = {
  v: 1,
  kind: "server",
  status: "running",
  startedAt: 100,
  label: "Looking up",
  icon: "search",
  queries: ["KSFO"],
}
const completed: B4ToolStep = {
  v: 1,
  kind: "server",
  status: "completed",
  startedAt: 100,
  settledAt: 200,
  label: "Looked up",
  icon: "search",
  queries: ["KSFO"],
  sources: [{ id: "c:0", kind: "url", title: "Weather", href: "https://example.com" }],
}

for (const owner of [undefined, "child"] as const) {
  test(`carries the current v1 step on call/result metadata for ${owner ?? "root"}`, async () => {
    const chunks: B4AgentStreamChunk[] = [
      { type: "step", data: { ...running, toolCallId: "c" } },
      { type: "tool_call", data: { id: "c", name: "lookup", input: {} } },
      {
        type: "tool_result",
        data: {
          id: "c",
          name: "lookup",
          output: {
            tool_call_id: "c",
            content: "Weather",
            status: "success",
            additional_kwargs: { b4_step: completed },
          },
        },
      },
    ]
    const input =
      owner === undefined
        ? chunks
        : [
            {
              type: "subagent.start",
              data: { call_id: owner, subagent: "helper", route_id: "/helper", depth: 1 },
            },
            ...chunks.map((chunk) => ({
              type: `subagent.${chunk.type}`,
              data: {
                ...(chunk.data as object),
                call_id: owner,
                subagent: "helper",
                route_id: "/helper",
                depth: 1,
              },
            })),
            {
              type: "subagent.end",
              data: {
                call_id: owner,
                subagent: "helper",
                route_id: "/helper",
                depth: 1,
                result: "done",
              },
            },
          ]

    const events = await collect(input)
    const frames = events.filter(
      (event) => event.type === EventType.TOOL_CALL_START || event.type === EventType.TOOL_CALL_END,
    )
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)

    expect(frames).toHaveLength(2)
    for (const frame of frames) {
      expect(frame.metadata?.[B4_STEP_METADATA_KEY]).toEqual(running)
      expect(frame.subagentRunId).toBe(owner)
    }
    expect(result?.metadata?.[B4_STEP_METADATA_KEY]).toEqual(completed)
    expect(result?.subagentRunId).toBe(owner)
    expect(foldSteps(events).steps.c).toEqual(completed)
  })
}

test("streams START before execution, without inventing a start time or buffering arguments", async () => {
  let continueExecution!: () => void
  const gate = new Promise<void>((resolve) => {
    continueExecution = resolve
  })
  async function* source(): AsyncGenerator<B4AgentStreamChunk> {
    yield { type: "tool_call_args", data: { id: "c", name: "lookup", delta: "{" } }
    await gate
    yield { type: "tool_call", data: { id: "c", name: "lookup", input: {} } }
    yield { type: "step", data: { ...running, toolCallId: "c" } }
  }
  const stream = toAguiEvents(source(), { threadId: "thread", runId: "run" })

  await stream.next()
  const start = await stream.next()
  continueExecution()
  const rest = []
  for await (const event of stream) rest.push(event)

  expect(start.value).toMatchObject({ type: EventType.TOOL_CALL_START, toolCallId: "c" })
  expect(start.value?.metadata?.[B4_STEP_METADATA_KEY]).toBeUndefined()
  expect(rest.find((event) => event.type === EventType.CUSTOM)).toMatchObject({
    name: "b4.step",
    value: { ...running, toolCallId: "c" },
  })
})

test("a Command result uses the matching tool message's failed step and readable error", async () => {
  const failed: B4ToolStep = {
    ...running,
    status: "failed",
    label: "Lookup failed",
    settledAt: 200,
    error: { message: "Network unavailable", code: "OFFLINE" },
  }
  const output = {
    update: {
      messages: [
        {
          tool_call_id: "c",
          content: "Tool lookup failed: Network unavailable",
          status: "error",
          additional_kwargs: { b4_step: failed },
        },
        {
          tool_call_id: "other",
          content: "Another result",
          status: "success",
          additional_kwargs: { b4_step: completed },
        },
      ],
    },
  }

  const events = await collect([
    { type: "tool_call", data: { id: "c", name: "lookup", input: {} } },
    { type: "tool_result", data: { id: "c", name: "lookup", output } },
  ])
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)

  expect(result).toMatchObject({
    content: "Tool lookup failed: Network unavailable",
    error: "Network unavailable",
    metadata: { "b4.step": failed },
  })
  expect(foldSteps(events).steps.c).toEqual(failed)
})

test("keeps a denied result denied even after a late completed call update", async () => {
  const denied: B4ToolStep = {
    v: 1,
    kind: "server",
    status: "denied",
    icon: "search",
    decision: "deny",
  }

  const events = await collect([
    { type: "tool_call", data: { id: "c", name: "lookup", input: {} } },
    {
      type: "tool_result",
      data: {
        id: "c",
        name: "lookup",
        output: {
          tool_call_id: "c",
          status: "success",
          content: "Not permitted",
          additional_kwargs: { b4_step: denied },
        },
      },
    },
    { type: "step", data: { ...completed, toolCallId: "c" } },
  ])

  expect(
    events.find((event) => event.type === EventType.TOOL_CALL_RESULT)?.metadata?.[
      B4_STEP_METADATA_KEY
    ],
  ).toEqual(denied)
  expect(foldSteps(events).steps.c?.status).toBe("denied")
})

test("normalizes legacy CUSTOM input into v1 and preserves open provider fields", async () => {
  const events = await collect([
    { type: "tool_call", data: { id: "legacy", name: "lookup", input: {} } },
    {
      type: "step",
      data: { tool_call_id: "legacy", status: "completed", sources: [{ title: "Old" }] },
    },
    { type: "tool_call", data: { id: "p", name: "web_search", input: {} } },
    {
      type: "step",
      data: {
        v: 1,
        toolCallId: "p",
        kind: "provider",
        status: "running",
        provider: "future-provider",
        builtin: "future-tool",
        icon: "future-icon",
        queries: ["Weather"],
      },
    },
  ])

  expect(
    events.filter((event) => event.type === EventType.CUSTOM).map((event) => event.value),
  ).toEqual([
    {
      v: 1,
      kind: "server",
      toolCallId: "legacy",
      status: "completed",
      sources: [{ id: "legacy:0", kind: "record", title: "Old" }],
    },
    {
      v: 1,
      kind: "provider",
      toolCallId: "p",
      status: "running",
      provider: "future-provider",
      builtin: "future-tool",
      icon: "future-icon",
      queries: ["Weather"],
    },
  ])
})

for (const command of [false, true]) {
  test(`uses the matched call id for legacy persisted source ids (${command ? "Command" : "direct"})`, async () => {
    const message = {
      tool_call_id: "legacy-result",
      status: "success",
      content: "Found",
      additional_kwargs: {
        b4_step: {
          status: "completed",
          sources: [{ title: "Legacy" }],
          startedAt: "2026-10-22T00:00:00.000Z",
          settledAt: "2026-10-22T00:00:01.000Z",
        },
      },
    }

    const events = await collect([
      { type: "tool_call", data: { id: "legacy-result", name: "lookup", input: {} } },
      {
        type: "tool_result",
        data: {
          id: "legacy-result",
          name: "lookup",
          output: command ? { update: { messages: [message] } } : message,
        },
      },
    ])
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)

    expect(result?.metadata?.[B4_STEP_METADATA_KEY]).toMatchObject({
      sources: [{ id: "legacy-result:0", kind: "record", title: "Legacy" }],
    })
  })
}

test("a stored ToolMessage.error fails live output just as it fails restore", async () => {
  const message = {
    tool_call_id: "c",
    status: "success",
    content: "Stored failure",
    error: "Stored failure",
    additional_kwargs: { b4_step: completed },
  }

  const events = await collect([
    { type: "tool_call", data: { id: "c", name: "lookup", input: {} } },
    { type: "tool_result", data: { id: "c", name: "lookup", output: message } },
  ])

  expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
    error: "Stored failure",
    metadata: { "b4.step": { status: "failed", error: { message: "Stored failure" } } },
  })
  expect(foldSteps(events).steps.c?.status).toBe("failed")
})

for (const streamed of [false, true]) {
  test(`re-presenting a cancelled call reopens metadata (${streamed ? "streamed" : "whole"})`, async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "c", name: "lookup", input: {} } },
      {
        type: "step",
        data: {
          v: 1,
          kind: "server",
          toolCallId: "c",
          status: "cancelled",
          label: "Cancelled",
          settledAt: 100,
        },
      },
      ...(streamed
        ? [{ type: "tool_call_args", data: { id: "c", name: "lookup", delta: "{}" } }]
        : []),
      { type: "tool_call", data: { id: "c", name: "lookup", input: {} } },
      { type: "tool_result", data: { id: "c", name: "lookup", output: "Done" } },
    ])

    expect(foldSteps(events).steps.c).toEqual({ v: 1, kind: "server", status: "completed" })
  })
}

test("a cancelled step held before its first START stays cancelled", async () => {
  const events = await collect([
    { type: "step", data: { v: 1, kind: "server", toolCallId: "c", status: "cancelled" } },
    { type: "tool_call", data: { id: "c", name: "lookup", input: {} } },
  ])

  expect(foldSteps(events).steps.c?.status).toBe("cancelled")
})

test("a running update after a frame-only result cannot contribute fields to a later failure", async () => {
  const events = await collect([
    { type: "tool_call", data: { id: "c", name: "lookup", input: {} } },
    { type: "tool_result", data: { id: "c", name: "lookup", output: "Done" } },
    {
      type: "step",
      data: {
        v: 1,
        kind: "server",
        toolCallId: "c",
        status: "running",
        icon: "search",
        queries: ["Late"],
        startedAt: 500,
      },
    },
    {
      type: "step",
      data: {
        v: 1,
        kind: "server",
        toolCallId: "c",
        status: "failed",
        error: { message: "Late failure" },
      },
    },
  ])

  expect(foldSteps(events).steps.c).toEqual({
    v: 1,
    kind: "server",
    status: "failed",
    error: { message: "Late failure" },
  })
})

test("preserves custom icons through standard call metadata and live view projection", async () => {
  const active = Object.freeze({ ...running, icon: "weather-radar" })
  const settled = Object.freeze({ ...completed, icon: "weather-radar" })
  const chunks: readonly B4AgentStreamChunk[] = [
    { type: "step", data: { ...active, toolCallId: "radar-call" } },
    { type: "tool_call", data: { id: "radar-call", name: "radar", input: {} } },
    {
      type: "tool_result",
      data: {
        id: "radar-call",
        name: "radar",
        output: {
          tool_call_id: "radar-call",
          content: "clear",
          status: "success",
          additional_kwargs: { b4_step: settled },
        },
      },
    },
  ]

  const events = await collect(chunks)
  const frames = events.filter(
    (event) =>
      event.type === EventType.TOOL_CALL_START ||
      event.type === EventType.TOOL_CALL_END ||
      event.type === EventType.TOOL_CALL_RESULT,
  )
  const runningEvents = events.slice(
    0,
    events.findIndex((event) => event.type === EventType.TOOL_CALL_RESULT),
  )
  const runningView = runningEvents.reduce(
    (view, event) => reduceTurns(view, event as BaseEvent),
    EMPTY_TURNS,
  )
  const settledView = events.reduce(
    (view, event) => reduceTurns(view, event as BaseEvent),
    EMPTY_TURNS,
  )

  expect(frames).toEqual([
    expect.objectContaining({
      type: EventType.TOOL_CALL_START,
      toolCallId: "radar-call",
      metadata: { [B4_STEP_METADATA_KEY]: active },
    }),
    expect.objectContaining({
      type: EventType.TOOL_CALL_END,
      toolCallId: "radar-call",
      metadata: { [B4_STEP_METADATA_KEY]: active },
    }),
    expect.objectContaining({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "radar-call",
      metadata: { [B4_STEP_METADATA_KEY]: settled },
    }),
  ])
  expect(runningView.turns[0]?.steps[0]).toMatchObject({
    id: "radar-call",
    status: "running",
    icon: "weather-radar",
  })
  expect(settledView.turns[0]?.steps[0]).toMatchObject({
    id: "radar-call",
    status: "done",
    icon: "weather-radar",
  })
  expect(foldSteps(events).steps["radar-call"]).toEqual(settled)
})
