import { normalizeProviderMessage } from "@b4run/sdk"
import { AIMessage, type AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import * as google from "@langchain/google"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { expect, test } from "vitest"
import { type AgentStreamChunk, streamAgent } from "../src/agent-adapter.ts"

import { googleProviderOptions } from "../src/google-provider.ts"
import { createProviderStreamState, projectProviderChunk } from "../src/provider-stream.ts"

/** Creates a real Google chat model with a local transport. */
function model(fetch: (request: Request) => Promise<Response>) {
  return new google.ChatGoogle({
    ...googleProviderOptions(google),
    model: "gemini-3-flash-preview",
    outputVersion: "v0",
    apiClient: { hasApiKey: () => true, getProjectId: async () => "test", fetch },
  })
}

/** Encodes native Google responses as the public SSE transport. */
function sse(chunks: unknown[]): Response {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

const invocation = {
  toolCall: { id: "search-1", toolType: "GOOGLE_SEARCH_WEB", args: { query: "b4" } },
}
const completion = {
  toolResponse: { id: "search-1", toolType: "GOOGLE_SEARCH_WEB", response: { output: "Found" } },
}
const grounding = {
  groundingChunks: [{ web: { uri: "https://b4.run", title: "B4" } }],
  groundingSupports: [{ segment: { startIndex: 0, endIndex: 2 }, groundingChunkIndices: [0] }],
  searchEntryPoint: { renderedContent: "<p>Search</p>" },
}

/** Collects the legacy streaming chunks, preserving their native merge semantics. */
async function collect(chat: ReturnType<typeof model>, prompt = "Search") {
  const chunks: AIMessageChunk[] = []
  for await (const chunk of await chat.stream(prompt)) chunks.push(chunk)
  const merged = chunks.reduce((left, right) => left.concat(right))
  return { chunks, merged }
}

test("retains ordered native candidates and metadata-only tails through real Google streaming", async () => {
  const candidates = [
    { index: 0, content: { parts: [invocation] } },
    { index: 0, content: { parts: [{ text: "B4" }, completion] } },
    { index: 0, groundingMetadata: grounding },
  ]
  const chat = model(async () => sse(candidates.map((candidate) => ({ candidates: [candidate] }))))

  const { chunks, merged } = await collect(chat)

  expect(chunks[0]?.additional_kwargs.b4_google_raw_candidates).toEqual([
    { ordinal: 0, candidate: candidates[0] },
  ])
  expect(merged.additional_kwargs.b4_google_raw_candidates).toEqual(
    candidates.map((candidate, ordinal) => ({ ordinal, candidate })),
  )
  expect(merged.text).toBe("B4")
})

test("emits native-only activity before the transport finishes and forwards each token callback once", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
  })
  const chat = model(
    async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  )
  const tokens: unknown[] = []
  const streamPromise = chat.stream("Search", {
    callbacks: [
      {
        handleLLMNewToken(_text, _idx, _runId, _parent, _tags, fields) {
          tokens.push(fields?.chunk)
        },
      },
    ],
  })
  const iteratorPromise = streamPromise.then((value) => value[Symbol.asyncIterator]())
  const first = iteratorPromise.then((iterator) => iterator.next())

  controller?.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ candidates: [{ index: 0, content: { parts: [invocation] } }] })}\n\n`,
    ),
  )
  const result = await first
  controller?.close()
  const iterator = await iteratorPromise
  while (!(await iterator.next()).done) {
    /* consume upstream completion */
  }

  expect(result.value?.additional_kwargs.b4_google_raw_candidates).toEqual([
    { ordinal: 0, candidate: { index: 0, content: { parts: [invocation] } } },
  ])
  expect(tokens).toHaveLength(2)
})

test("retains non-streaming responses and replays native parts in order without duplicate client calls", async () => {
  const parts = [
    { text: "thinking", thought: true, thoughtSignature: "sig" },
    invocation,
    completion,
    {
      functionCall: { id: "client-1", name: "lookup", args: { key: "x" } },
      thoughtSignature: "client-sig",
    },
  ]
  const candidate = {
    index: 0,
    content: { parts },
    groundingMetadata: grounding,
    finishReason: "STOP",
  }
  const requests: unknown[] = []
  const chat = model(async (request) => {
    requests.push(await request.json())
    return Response.json({ candidates: [candidate] })
  })

  const message = await chat.invoke("Search")
  const hydrated = new AIMessage(JSON.parse(JSON.stringify(message.toJSON())).kwargs)
  const beforeReplay = JSON.stringify(hydrated)
  await chat.invoke([
    new HumanMessage("Search"),
    hydrated,
    new ToolMessage({ content: "yes", tool_call_id: "client-1" }),
  ])

  expect(message.additional_kwargs.b4_google_raw_candidates).toEqual([{ ordinal: 0, candidate }])
  expect((requests[1] as { contents: unknown[] }).contents[1]).toEqual({ role: "model", parts })
  expect(hydrated.tool_calls).toHaveLength(1)
  expect(hydrated.content).toEqual(message.content)
  expect(JSON.stringify(hydrated)).toBe(beforeReplay)
  expect(JSON.parse(JSON.stringify(message)).kwargs).not.toHaveProperty("lc_kwargs")
  expect(JSON.parse(JSON.stringify(message)).kwargs).not.toHaveProperty("lc_serializable")
})

test("requests server-side invocations for built-ins alone and validated mixed function calls", async () => {
  const requests: Record<string, unknown>[] = []
  const chat = model(async (request) => {
    requests.push((await request.json()) as Record<string, unknown>)
    return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })
  })

  await chat.bindTools([{ googleSearch: {} }]).invoke([new HumanMessage("Search")])
  await chat
    .bindTools([
      { googleSearch: {} },
      {
        functionDeclarations: [{ name: "lookup", parameters: { type: "object", properties: {} } }],
      },
    ])
    .invoke([new HumanMessage("Search")])

  expect(requests[0]?.toolConfig).toEqual({ includeServerSideToolInvocations: true })
  expect(requests[1]?.toolConfig).toEqual({
    includeServerSideToolInvocations: true,
    functionCallingConfig: { mode: "VALIDATED" },
  })
})

test("keeps retained candidates isolated between concurrent calls on the same Google handler", async () => {
  const chat = model(async (request) => {
    const body = (await request.json()) as { contents: { parts: { text: string }[] }[] }
    const text = body.contents[0]?.parts[0]?.text
    return sse([{ candidates: [{ index: 0, content: { parts: [{ text }] } }] }])
  })

  const results = await Promise.all([collect(chat, "first"), collect(chat, "second")])

  for (const [index, result] of results.entries())
    expect(result.merged.additional_kwargs.b4_google_raw_candidates).toEqual([
      {
        ordinal: 0,
        candidate: { index: 0, content: { parts: [{ text: index === 0 ? "first" : "second" }] } },
      },
    ])
})

test("forwards abort to the Google transport without inventing a tool completion", async () => {
  const abort = new AbortController()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let transportAborted = false
  const chat = model(async (request) => {
    request.signal.addEventListener("abort", () => {
      transportAborted = true
      controller?.error(new Error("Transport aborted"))
    })
    return new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  const iteratorPromise = chat
    .stream("Search", { signal: abort.signal })
    .then((value) => value[Symbol.asyncIterator]())
  const first = iteratorPromise.then((iterator) => iterator.next())
  // Let the request install its transport before supplying the native event.
  while (!controller) await new Promise<void>((resolve) => setImmediate(resolve))
  controller.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [invocation] } }] })}\n\n`,
    ),
  )
  const activity = await first
  const iterator = await iteratorPromise
  await iterator.next()

  const pending = iterator.next()
  abort.abort()

  await expect(pending).rejects.toThrow()
  expect(transportAborted).toBe(true)
  expect(activity.value?.additional_kwargs.b4_google_raw_candidates).toEqual([
    { ordinal: 0, candidate: { content: { parts: [invocation] } } },
  ])
})

test("streams canonical code activity through a real graph before EOF and preserves its replay identity", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const chat = model(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  )
  const graph = createAgent({ model: chat, tools: [] })
  let resolveLive: ((value: ReturnType<typeof normalizeProviderMessage>) => void) | undefined
  const livePromise = new Promise<ReturnType<typeof normalizeProviderMessage>>((resolve) => {
    resolveLive = resolve
  })
  let saved: AIMessage | undefined
  const run = (async () => {
    for await (const event of graph.streamEvents(
      { messages: [new HumanMessage("Run code")] },
      { version: "v2" },
    )) {
      if (
        event.event === "on_chat_model_stream" &&
        event.data.chunk.additional_kwargs?.b4_google_raw_candidates
      ) {
        resolveLive?.(
          normalizeProviderMessage(event.data.chunk, {
            provider: "google",
            messageId: "ephemeral-run",
          }),
        )
      }
      if (event.event === "on_chat_model_end") saved = event.data.output
    }
  })()
  while (!controller) await new Promise<void>((resolve) => setImmediate(resolve))

  controller.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ executableCode: { language: "PYTHON", code: "print(1)" } }] }, groundingMetadata: grounding }] })}\n\n`,
    ),
  )
  const live = await livePromise
  controller.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" } }, { text: "1" }] }, finishReason: "STOP" }] })}\n\n`,
    ),
  )
  controller.close()
  await run
  const restored = new AIMessage(JSON.parse(JSON.stringify(saved?.toJSON())).kwargs)
  const final = normalizeProviderMessage(restored, {
    provider: "google",
    messageId: "different-run",
  })

  expect(live.calls[0]?.step.status).toBe("running")
  expect(live.calls[0]?.id).toBe(`${saved?.id}:code:0`)
  expect(final.calls[0]?.id).toBe(live.calls[0]?.id)
  expect(final.calls[0]?.step.status).toBe("completed")
  expect(live.answer?.sources?.[0]?.id).toBe(`${saved?.id}:source:0`)
  expect(final.answer?.sources?.[0]?.id).toBe(live.answer?.sources?.[0]?.id)
})

test("streams Google code START and RESULT through streamAgent before EOF and reconciles retained records once", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const chat = model(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  )
  const checkpointer = new MemorySaver()
  const graph = createAgent({ model: chat, tools: [], checkpointer })
  const chunks: AgentStreamChunk[] = []
  let resolveStart: (() => void) | undefined
  let resolveResult: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    resolveStart = resolve
  })
  const completed = new Promise<void>((resolve) => {
    resolveResult = resolve
  })
  const run = (async () => {
    for await (const chunk of streamAgent({
      entry: graph,
      input: { messages: [new HumanMessage("Run code")] },
      checkpointer,
      threadId: "google-live",
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push(chunk)
      if (chunk.type === "step" && (chunk.data as { status?: string }).status === "running")
        resolveStart?.()
      if (chunk.type === "tool_result") resolveResult?.()
    }
  })()
  while (!controller) await new Promise<void>((resolve) => setImmediate(resolve))
  controller.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ executableCode: { code: "print(1)" } }] } }] })}\n\n`,
    ),
  )
  await started

  controller.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" } }, { text: "1" }] } }] })}\n\n`,
    ),
  )
  const completedBeforeEof = await Promise.race([
    completed.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
  ])
  controller.close()
  await run
  const snapshot: unknown = await graph.getState({ configurable: { thread_id: "google-live" } })
  const saved = (snapshot as { values: { messages: AIMessage[] } }).values.messages.at(
    -1,
  ) as AIMessage
  const restored = new AIMessage(JSON.parse(JSON.stringify(saved.toJSON())).kwargs)
  const projection = normalizeProviderMessage(restored, {
    provider: "google",
    messageId: "new-run",
  })

  expect(completedBeforeEof).toBe(true)
  expect(chunks.filter((chunk) => chunk.type === "tool_result")).toHaveLength(1)
  expect(projection.calls[0]?.id).toBe(`${saved.id}:code:0`)
  expect(chunks.find((chunk) => chunk.type === "tool_result")?.data).toMatchObject({
    id: projection.calls[0]?.id,
    output: "1",
  })
  expect(saved.additional_kwargs.b4_google_raw_candidates).toHaveLength(2)
})

test("reconciles retained Google ordinals idempotently while preserving repeated native parts", () => {
  const state = createProviderStreamState()
  const candidates = [0, 1].map((ordinal) => ({
    ordinal,
    candidate: { index: 0, content: { parts: [{ executableCode: { code: "print(1)" } }] } },
  }))
  const message = { id: "assistant", additional_kwargs: { b4_google_raw_candidates: candidates } }
  const before = JSON.stringify(message)

  for (const candidate of candidates)
    projectProviderChunk(
      state,
      { id: "assistant", additional_kwargs: { b4_google_raw_candidates: [candidate] } },
      "live-run",
      false,
      "google",
    )
  projectProviderChunk(state, message, "live-run", true, "google")
  const projection = normalizeProviderMessage(state.message, {
    provider: "google",
    messageId: "restore-run",
  })

  expect(state.message.additional_kwargs).toMatchObject({ b4_google_raw_candidates: candidates })
  expect(projection.calls.map((call) => call.id)).toEqual(["assistant:code:0", "assistant:code:1"])
  expect(JSON.stringify(message)).toBe(before)
})
