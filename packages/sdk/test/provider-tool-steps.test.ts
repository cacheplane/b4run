import { expect, test } from "vitest"
import { normalizeProviderMessage } from "../src/provider-tool-steps.ts"

const options = { messageId: "m1" }

test("reads OpenAI progress objects without completing at EOF", () => {
  const message = {
    response_metadata: {
      tool_outputs: { id: "s1", type: "web_search_call", action: { query: "weather" } },
      finish_reason: "stop",
    },
  }

  const { calls } = normalizeProviderMessage(message, options)

  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    id: "s1",
    name: "web_search",
    input: { query: "weather" },
    step: { kind: "provider", provider: "openai", status: "running", queries: ["weather"] },
  })
  expect(calls[0]?.step).not.toHaveProperty("toolCallId")
})

test("raw failed code overrides lossy v1 success and keeps readable output", () => {
  const message = {
    contentBlocks: [
      { type: "server_tool_call", id: "c1", name: "code_interpreter", args: { code: "1/0" } },
      { type: "server_tool_call_result", toolCallId: "c1", status: "success", output: "ok" },
    ],
    additional_kwargs: {
      tool_outputs: [
        {
          type: "code_interpreter_call",
          id: "c1",
          status: "incomplete",
          code: "1/0",
          outputs: [{ type: "logs", logs: "division by zero" }],
        },
      ],
    },
  }

  const { calls } = normalizeProviderMessage(message, options)

  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    id: "c1",
    result: "division by zero",
    step: { status: "failed", builtin: "code_execution", error: { code: "incomplete" } },
  })
})

test("reads final OpenAI output and deduplicates native and v1 citations", () => {
  const citation = {
    type: "url_citation",
    url: "https://example.com",
    title: "Example",
    start_index: 0,
    end_index: 5,
  }
  const message = {
    response_metadata: {
      output: [
        {
          type: "web_search_call",
          id: "s1",
          status: "completed",
          action: { sources: [{ url: "https://example.com", title: "Example" }] },
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "hello", annotations: [citation] }],
        },
      ],
    },
    contentBlocks: [{ type: "text", text: "hello", annotations: [citation] }],
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.calls[0]?.step.sources?.[0]?.id).toBe("s1:source:0")
  expect(result.answer?.citations).toEqual([
    { sourceId: "s1:source:0", block: 0, start: 0, end: 5 },
  ])
})

test("image generation never exposes opaque base64 results", () => {
  const message = {
    additional_kwargs: {
      tool_outputs: [
        { id: "i1", type: "image_generation_call", status: "completed", result: "SECRET_BASE64" },
      ],
    },
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.calls[0]?.step.status).toBe("completed")
  expect(JSON.stringify(result)).not.toContain("SECRET_BASE64")
})

test("Anthropic preserves indexed partial input and native search errors", () => {
  const message = {
    content: [
      { type: "server_tool_use", id: "a1", name: "web_search", index: 2, input: {} },
      { type: "input_json_delta", index: 2, partial_json: '{"query":"wea' },
      {
        type: "web_search_tool_result",
        tool_use_id: "a1",
        content: { type: "web_search_tool_result_error", error_code: "rate_limit_exceeded" },
      },
    ],
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.calls[0]).toMatchObject({
    id: "a1",
    input: '{"query":"wea',
    step: { status: "failed", error: { code: "rate_limit_exceeded" } },
  })
})

test("Anthropic encrypted citation indices are never answer offsets", () => {
  const message = {
    content: [
      { type: "server_tool_use", id: "a1", name: "web_search", input: { query: "q" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "a1",
        content: [
          {
            type: "web_search_result",
            url: "https://example.com",
            title: "Original title",
            encrypted_content: "SECRET",
          },
        ],
      },
      {
        type: "text",
        text: "answer",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com",
            title: "Original title",
            encrypted_index: "SECRET",
            cited_text: "quote",
          },
        ],
      },
    ],
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.calls[0]?.step.sources?.[0]?.title).toBe("Original title")
  expect(result.answer?.citations).toEqual([{ sourceId: "a1:source:0", block: 0, quote: "quote" }])
  expect(JSON.stringify(result)).not.toContain("SECRET")
})

test("Google grounding makes answer annotations without inventing calls", () => {
  const html = '<div data-x="1">Search <b>Suggestions</b></div>'
  const message = {
    additional_kwargs: {
      groundingMetadata: {
        groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
        groundingSupports: [
          { groundingChunkIndices: [0], segment: { startIndex: 0, endIndex: 6, text: "answer" } },
        ],
        searchEntryPoint: { renderedContent: html },
      },
    },
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.calls).toEqual([])
  expect(result.answer?.sources?.[0]).toMatchObject({ href: "https://example.com" })
  expect(result.answer?.citations?.[0]).toMatchObject({ start: 0, end: 6 })
  expect(result.answer?.attribution).toEqual([
    { provider: "google", kind: "search-suggestions", html, mustRender: true },
  ])
})

test("Google code parts have stable message ordinal ids and actual result outcomes", () => {
  const message = {
    content: [
      { executableCode: { language: "PYTHON", code: "print(1)" } },
      { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" } },
      { executableCode: { code: "wait()" } },
    ],
  }

  const result = normalizeProviderMessage(message, { messageId: "g1", provider: "google" })

  expect(result.calls.map((call) => [call.id, call.step.status, call.result])).toEqual([
    ["g1:code:0", "completed", "1"],
    ["g1:code:1", "running", undefined],
  ])
})

test("v1 blocks fallback supports calls and result errors", () => {
  const message = {
    contentBlocks: [
      { type: "server_tool_call", id: "v1", name: "web_search", args: { query: "q" } },
      { type: "server_tool_call_result", toolCallId: "v1", status: "error", output: "Unavailable" },
    ],
  }

  const result = normalizeProviderMessage(message, { ...options, provider: "openai" })

  expect(result.calls[0]).toMatchObject({
    input: { query: "q" },
    result: "Unavailable",
    step: { status: "failed", error: { message: "Unavailable" } },
  })
})

test("serialized kwargs and stored provider maps restore without mutation", () => {
  const message = {
    kwargs: {
      content: "answer",
      additional_kwargs: {
        b4_steps: {
          saved: {
            v: 1,
            kind: "provider",
            builtin: "web_search",
            provider: "openai",
            status: "completed",
            label: "😀".repeat(130),
          },
        },
        b4_answer: {
          v: 1,
          sources: [
            { id: "saved:source:0", kind: "url", title: "Saved", href: "https://example.com" },
          ],
        },
      },
      tool_calls: [{ id: "ordinary", name: "app" }],
    },
  }
  const before = structuredClone(message)

  const result = normalizeProviderMessage(message, options)

  expect(result.calls[0]?.id).toBe("saved")
  expect(Array.from(result.calls[0]?.step.label ?? "")).toHaveLength(120)
  expect(result.answer?.sources?.[0]?.title).toBe("Saved")
  expect(message).toEqual(before)
})

test("ignores deferred file search and Anthropic disabled tools", () => {
  const message = {
    content: [{ type: "server_tool_use", id: "f", name: "web_fetch", input: {} }],
    additional_kwargs: {
      tool_outputs: [{ type: "file_search_call", id: "fs", status: "completed" }],
    },
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.calls).toEqual([])
})

test("Google retained native tool calls use provider ids and snake case grounding", () => {
  const message = {
    content: [
      {
        toolCall: {
          id: "native-google",
          toolType: "GOOGLE_SEARCH_WEB",
          args: { query: "weather" },
        },
      },
      {
        toolResponse: {
          id: "native-google",
          toolType: "GOOGLE_SEARCH_WEB",
          response: { results: [] },
        },
      },
    ],
    response_metadata: {
      grounding_metadata: {
        groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
      },
    },
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.calls[0]).toMatchObject({
    id: "native-google",
    name: "web_search",
    step: { provider: "google", status: "completed" },
  })
  expect(result.answer?.sources).toHaveLength(1)
})

test("raw Anthropic citations suppress lossy v1 numeric encrypted offsets", () => {
  const message = {
    content: [
      {
        type: "text",
        text: "answer",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com",
            title: "Example",
            cited_text: "quote",
            encrypted_index: "123",
          },
        ],
      },
    ],
    contentBlocks: [
      {
        type: "text",
        text: "answer",
        annotations: [
          {
            type: "citation",
            source: "url",
            url: "https://example.com",
            title: "Example",
            startIndex: 123,
            endIndex: 123,
            citedText: "quote",
          },
        ],
      },
    ],
  }

  const result = normalizeProviderMessage(message, { ...options, provider: "anthropic" })

  expect(result.answer?.citations).toEqual([{ sourceId: "m1:source:0", block: 0, quote: "quote" }])
})

test("v1 structured code output projects stdout without opaque payloads", () => {
  const message = {
    contentBlocks: [
      { type: "server_tool_call", id: "v", name: "code_interpreter", args: { code: "print(1)" } },
      {
        type: "server_tool_call_result",
        toolCallId: "v",
        status: "success",
        output: { type: "code_interpreter_output", stdout: "1", returnCode: 0 },
      },
    ],
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.calls[0]?.result).toBe("1")
})

test("native progress does not discard stored source details or settled status", () => {
  const message = {
    additional_kwargs: {
      b4_steps: {
        s: {
          v: 1,
          kind: "provider",
          provider: "openai",
          builtin: "web_search",
          status: "completed",
          sources: [{ id: "s:source:0", title: "Saved", href: "https://example.com" }],
        },
      },
    },
    response_metadata: { tool_outputs: { type: "web_search_call", id: "s" } },
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.calls[0]?.step.status).toBe("completed")
  expect(result.calls[0]?.step.sources?.[0]?.title).toBe("Saved")
})

test("stored failures survive native progress and standardized arguments enrich sparse progress", () => {
  const message = {
    contentBlocks: [
      { type: "server_tool_call", id: "s", name: "web_search", args: { query: "weather" } },
    ],
    additional_kwargs: {
      b4_steps: {
        s: {
          v: 1,
          kind: "provider",
          provider: "openai",
          builtin: "web_search",
          status: "failed",
          error: { message: "Unavailable" },
        },
      },
    },
    response_metadata: { tool_outputs: { type: "web_search_call", id: "s" } },
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.calls[0]?.step.status).toBe("failed")
  expect(result.calls[0]?.input).toEqual({ query: "weather" })
})

test("preserves distinct citation occurrences while deduplicating native replay carriers", () => {
  const annotations = [
    {
      type: "url_citation",
      url: "https://example.com",
      title: "Example",
      start_index: 0,
      end_index: 3,
    },
    {
      type: "url_citation",
      url: "https://example.com",
      title: "Example",
      start_index: 5,
      end_index: 8,
    },
  ]
  const message = {
    content: [{ type: "text", text: "one, two", annotations }],
    response_metadata: {
      output: [
        { type: "message", content: [{ type: "output_text", text: "one, two", annotations }] },
      ],
    },
  }

  const result = normalizeProviderMessage(message, options)

  expect(result.answer?.citations).toHaveLength(2)
  expect(result.answer?.citations?.map((entry) => [entry.start, entry.end])).toEqual([
    [0, 3],
    [5, 8],
  ])
})
