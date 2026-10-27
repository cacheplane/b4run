import { expect, test } from "vitest"
import { normalizeProviderMessage } from "../src/provider-tool-steps.ts"

/** Retains fragment candidates in the bridge's merge-safe representation. */
function retained(candidates: unknown[]) {
  return {
    b4_google_raw_candidates: candidates.map((candidate, ordinal) => ({ ordinal, candidate })),
  }
}

test("projects retained native search and code evidence using canonical assistant identity", () => {
  const message = {
    id: "assistant-1",
    content: [{ type: "executableCode", executableCode: { code: "print(1)" } }],
    additional_kwargs: retained([
      {
        index: 0,
        content: {
          parts: [
            {
              toolCall: { id: "search-1", toolType: "GOOGLE_SEARCH_IMAGE", args: { query: "b4" } },
            },
            { executableCode: { code: "print(1)" } },
          ],
        },
      },
      {
        index: 0,
        content: {
          parts: [
            {
              toolResponse: {
                id: "search-1",
                toolType: "GOOGLE_SEARCH_IMAGE",
                response: { output: "Found" },
              },
            },
            { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" } },
          ],
        },
      },
    ]),
  }

  const result = normalizeProviderMessage(message, {
    provider: "google",
    messageId: "ephemeral-run",
  })

  expect(result.calls.map((call) => [call.id, call.step.status, call.result])).toEqual([
    ["search-1", "completed", "Found"],
    ["assistant-1:code:0", "completed", "1"],
  ])
})

test("merges grounding across all retained fragments without inventing a search call", () => {
  const message = {
    additional_kwargs: retained([
      {
        index: 0,
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://first.test", title: "First" } }],
          groundingSupports: [
            { segment: { startIndex: 0, endIndex: 5, text: "first" }, groundingChunkIndices: [0] },
          ],
          searchEntryPoint: { renderedContent: "first" },
        },
      },
      {
        index: 0,
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://second.test", title: "Second" } }],
          groundingSupports: [
            {
              segment: { startIndex: 6, endIndex: 12, text: "second" },
              groundingChunkIndices: [0],
            },
          ],
          searchEntryPoint: { renderedContent: "second" },
        },
      },
    ]),
  }

  const result = normalizeProviderMessage(message, { provider: "google", messageId: "assistant" })

  expect(result.calls).toEqual([])
  expect(result.answer?.sources?.map((source) => source.href)).toEqual([
    "https://first.test",
    "https://second.test",
  ])
  expect(result.answer?.citations?.map((citation) => citation.quote)).toEqual(["first", "second"])
  expect(result.answer?.attribution?.map((entry) => entry.html)).toEqual(["first", "second"])
})

test("projects URL context only when explicit invocation and result evidence exists", () => {
  const message = {
    additional_kwargs: retained([
      {
        content: {
          parts: [
            {
              toolCall: {
                id: "url-1",
                toolType: "URL_CONTEXT",
                args: { urls: ["https://b4.run"] },
              },
            },
            {
              toolResponse: {
                id: "url-1",
                toolType: "URL_CONTEXT",
                response: { output: "Read", sources: [{ url: "https://b4.run", title: "B4" }] },
              },
            },
          ],
        },
      },
    ]),
  }

  const result = normalizeProviderMessage(message, { provider: "google", messageId: "assistant" })

  expect(result.calls).toHaveLength(1)
  expect(result.calls[0]?.id).toBe("url-1")
  expect(result.calls[0]?.step.status).toBe("completed")
  expect(result.calls[0]?.step.builtin).toBe("web_fetch")
  expect(result.calls[0]?.step.label).toBe("Fetched page")
  expect(result.calls[0]?.step.sources?.[0]?.href).toBe("https://b4.run")
})

test("uses the Google fetch label while its explicit URL context call is running", () => {
  const message = {
    content: [
      { toolCall: { id: "url-1", toolType: "URL_CONTEXT", args: { urls: ["https://b4.run"] } } },
    ],
  }

  const result = normalizeProviderMessage(message, { provider: "google", messageId: "assistant" })

  expect(result.calls[0]?.step.builtin).toBe("web_fetch")
  expect(result.calls[0]?.step.label).toBe("Fetching page")
})

test("attaches documented URL context retrieval sources without inventing calls from metadata", () => {
  const metadata = {
    urlContextMetadata: {
      urlMetadata: [
        { retrievedUrl: "https://b4.run", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" },
      ],
    },
  }
  const message = {
    additional_kwargs: retained([
      {
        content: {
          parts: [
            {
              toolCall: {
                id: "url-1",
                toolType: "URL_CONTEXT",
                args: { urls: ["https://b4.run"] },
              },
            },
            {
              toolResponse: { id: "url-1", toolType: "URL_CONTEXT", response: { output: "Read" } },
            },
          ],
        },
      },
      metadata,
    ]),
  }

  const result = normalizeProviderMessage(message, { provider: "google", messageId: "assistant" })
  const metadataOnly = normalizeProviderMessage(
    { additional_kwargs: retained([metadata]) },
    { provider: "google", messageId: "assistant" },
  )

  expect(result.calls[0]?.step.sources?.[0]?.href).toBe("https://b4.run")
  expect(metadataOnly.calls).toEqual([])
  expect(metadataOnly.answer?.sources?.[0]?.href).toBe("https://b4.run")
})

test("retains grounding sources when a later fragment supplies only citation supports", () => {
  const message = {
    additional_kwargs: retained([
      { groundingMetadata: { groundingChunks: [{ web: { uri: "https://b4.run" } }] } },
      {
        groundingMetadata: {
          groundingSupports: [
            { segment: { startIndex: 0, endIndex: 2, text: "B4" }, groundingChunkIndices: [0] },
          ],
        },
      },
      { groundingMetadata: { searchEntryPoint: { renderedContent: "suggestions" } } },
    ]),
  }

  const result = normalizeProviderMessage(message, { provider: "google", messageId: "assistant" })

  expect(result.answer?.citations).toEqual([{ sourceId: "assistant:source:0", quote: "B4" }])
  expect(result.answer?.attribution?.[0]?.html).toBe("suggestions")
})

for (const modelProvider of ["google", "google-genai"]) {
  test(`keeps Google UTF-8 citation offsets out of character spans when restoring ${modelProvider}`, () => {
    const message = {
      id: "assistant",
      content: [
        {
          type: "text",
          text: "é 😀",
          annotations: [{ url: "https://b4.run", start_index: 3, end_index: 7, cited_text: "😀" }],
        },
      ],
      contentBlocks: [
        {
          type: "text",
          text: "é 😀",
          citations: [{ url: "https://b4.run", startIndex: 3, endIndex: 7, citedText: "😀" }],
        },
      ],
      response_metadata: { model_provider: modelProvider },
      additional_kwargs: retained([
        {
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://b4.run" } }],
            groundingSupports: [
              { segment: { startIndex: 3, endIndex: 7, text: "😀" }, groundingChunkIndices: [0] },
            ],
          },
        },
      ]),
    }

    const result = normalizeProviderMessage(message, { messageId: "restore-run" })

    expect(result.answer?.citations?.length).toBeGreaterThan(0)
    for (const citation of result.answer?.citations ?? []) {
      expect(citation).not.toHaveProperty("start")
      expect(citation).not.toHaveProperty("end")
      expect(citation.quote).toBe("😀")
      expect(citation.sourceId).toBe("assistant:source:0")
    }
  })
}
