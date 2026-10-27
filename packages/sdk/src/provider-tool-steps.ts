import {
  type B4AnswerAnnotations,
  type B4StepSource,
  type B4ToolStep,
  mergeToolStep,
  readAnswerAnnotations,
  readToolStep,
} from "./tool-step.js"

/** A provider-owned call; its native AIMessage remains the replay unit. */
export interface ProviderToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly step: B4ToolStep
  readonly result?: string
}

/** Provider activity and answer annotations projected from one assistant message. */
export interface ProviderMessageProjection {
  readonly calls: readonly ProviderToolCall[]
  readonly answer?: B4AnswerAnnotations
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : {}
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(record) : [])
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined
const bounded = (value: string): string => Array.from(value).slice(0, 120).join("")
const builtins: Readonly<Record<string, string>> = {
  web_search: "web_search",
  web_search_call: "web_search",
  code_interpreter: "code_execution",
  code_interpreter_call: "code_execution",
  code_execution: "code_execution",
  image_generation: "image_generation",
  image_generation_call: "image_generation",
}
const labels: Readonly<Record<string, string>> = {
  web_search: "Searching the web",
  code_execution: "Running code",
  image_generation: "Generating an image",
}
const completedLabels: Readonly<Record<string, string>> = {
  web_search: "Searched the web",
  code_execution: "Ran code",
  image_generation: "Generated image",
}
const toolNames: Readonly<Record<string, string>> = {
  web_search: "Web search",
  code_execution: "Code execution",
  image_generation: "Image generation",
}
const terminal = (value: unknown): B4ToolStep["status"] => {
  if (value === "failed" || value === "incomplete" || value === "error") return "failed"
  if (value === "completed" || value === "success") return "completed"
  if (value === "cancelled") return "cancelled"
  return "running"
}
const offset = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * Projects native provider activity without importing LangChain or modifying replay data.
 * Native v0 payloads take precedence over standardized v1 server-tool blocks.
 * Missing terminal evidence leaves calls running, including at model EOF.
 */
export function normalizeProviderMessage(
  message: unknown,
  options: { readonly provider?: string; readonly messageId: string },
): ProviderMessageProjection {
  const outer = record(message)
  const data = Object.keys(record(outer.kwargs)).length > 0 ? record(outer.kwargs) : outer
  const additional = record(data.additional_kwargs)
  const metadata = record(data.response_metadata)
  const calls = new Map<string, ProviderToolCall>()
  const nativeIds = new Set<string>()
  const savedIds = new Set<string>()
  const savedAnswer = readAnswerAnnotations(additional.b4_answer)
  const sources: B4StepSource[] = [...(savedAnswer?.sources ?? [])]
  const citations: NonNullable<B4AnswerAnnotations["citations"]>[number][] = [
    ...(savedAnswer?.citations ?? []),
  ]
  const attribution: NonNullable<B4AnswerAnnotations["attribution"]>[number][] = [
    ...(savedAnswer?.attribution ?? []),
  ]
  const content = list(data.content)
  const standardized = list(data.contentBlocks)

  function addCall(
    id: string,
    name: string,
    input: unknown,
    provider: string,
    status: B4ToolStep["status"],
    result?: string,
    errorCode?: string,
    native = true,
  ): void {
    const builtin = builtins[name]
    if (!builtin || (provider === "anthropic" && builtin !== "web_search")) return
    const previous = calls.get(id)
    const normalizedInput =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? { ...record(previous?.input), ...record(input) }
        : input
    const query = string(record(normalizedInput).query)
    const queries = Array.isArray(record(normalizedInput).queries)
      ? (record(normalizedInput).queries as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : query
        ? [query]
        : undefined
    const step: B4ToolStep = {
      v: 1,
      kind: "provider",
      builtin,
      provider,
      status,
      label: bounded(
        status === "running"
          ? (labels[builtin] ?? builtin)
          : status === "completed"
            ? (completedLabels[builtin] ?? builtin)
            : `${toolNames[builtin] ?? builtin} ${status}`,
      ),
      ...(queries ? { queries } : {}),
      ...(previous?.step.sources ? { sources: previous.step.sources } : {}),
      ...(status === "failed"
        ? {
            error: {
              message: result ?? errorCode ?? "Provider tool failed",
              ...(errorCode ? { code: errorCode } : {}),
            },
          }
        : {}),
    }
    const firstNative = native && !nativeIds.has(id)
    calls.set(id, {
      id,
      name: builtin,
      input: normalizedInput,
      step:
        firstNative && !savedIds.has(id) ? step : mergeToolStep(previous?.step, step, "message"),
      ...(result !== undefined ? { result } : {}),
    })
    if (native) nativeIds.add(id)
  }

  function addSource(value: RecordValue, owner?: string): B4StepSource | undefined {
    const href = string(value.url) ?? string(value.uri) ?? string(value.href)
    const fileId = string(value.file_id) ?? string(value.fileId)
    const containerId = string(value.container_id) ?? string(value.containerId)
    if (!href && !fileId) return undefined
    const ownerCall = owner ? calls.get(owner) : undefined
    const existing = [
      ...sources,
      ...[...calls.values()].flatMap((call) => call.step.sources ?? []),
    ].find(
      (source) =>
        (ownerCall ? ownerCall.step.sources?.includes(source) : true) &&
        (href
          ? source.href === href
          : source.fileId === fileId && source.containerId === containerId),
    )
    if (existing) return existing
    const ownSources = ownerCall?.step.sources ?? sources
    const source: B4StepSource = {
      id: `${owner ?? options.messageId}:source:${ownSources.length}`,
      kind: fileId ? "file" : "url",
      title: string(value.title) ?? string(value.filename) ?? href ?? fileId ?? "Source",
      ...(href ? { href } : {}),
      ...(fileId ? { fileId } : {}),
      ...(containerId ? { containerId } : {}),
      ...(string(value.snippet) ? { snippet: String(value.snippet) } : {}),
    }
    if (ownerCall)
      calls.set(ownerCall.id, {
        ...ownerCall,
        step: { ...ownerCall.step, sources: [...ownSources, source] },
      })
    else sources.push(source)
    return source
  }

  for (const [id, value] of Object.entries(record(additional.b4_steps))) {
    const read = readToolStep(value)
    if (read?.kind !== "provider") continue
    const { toolCallId: _toolCallId, ...step } = mergeToolStep(undefined, read, "message")
    calls.set(id, { id, name: step.builtin ?? "provider", input: {}, step })
    savedIds.add(id)
  }
  for (const block of [...content, ...standardized]) {
    if (block.type !== "server_tool_call") continue
    const id = string(block.id)
    if (id)
      addCall(
        id,
        String(block.name),
        block.args ?? {},
        options.provider ?? "unknown",
        "running",
        undefined,
        undefined,
        false,
      )
  }
  for (const block of [...content, ...standardized]) {
    if (block.type !== "server_tool_call_result") continue
    const id = string(block.toolCallId) ?? string(block.tool_call_id)
    const call = id ? calls.get(id) : undefined
    if (call)
      addCall(
        call.id,
        call.name,
        call.input,
        call.step.provider ?? "unknown",
        terminal(block.status),
        string(block.output) ??
          string(record(block.output).stdout) ??
          string(record(block.output).message),
        undefined,
        false,
      )
  }

  const outputs = [
    ...(Array.isArray(metadata.tool_outputs)
      ? list(metadata.tool_outputs)
      : Object.keys(record(metadata.tool_outputs)).length
        ? [record(metadata.tool_outputs)]
        : []),
    ...list(additional.tool_outputs),
    ...list(metadata.output),
  ]
  for (const output of outputs) {
    const name = string(output.type)
    const id = string(output.id)
    if (!name || !id || !builtins[name]) continue
    const action = record(output.action)
    const logs = list(output.outputs)
      .flatMap((entry) => (string(entry.logs) ? [String(entry.logs)] : []))
      .join("\n")
    const status = terminal(output.status)
    const error = record(output.error)
    addCall(
      id,
      name,
      name === "web_search_call"
        ? action
        : name === "code_interpreter_call"
          ? { code: output.code ?? "" }
          : { ...(string(output.revised_prompt) ? { prompt: output.revised_prompt } : {}) },
      "openai",
      status,
      logs ||
        string(error.message) ||
        (status === "completed"
          ? name === "image_generation_call"
            ? "Image generated"
            : "Completed"
          : undefined),
      string(error.code) ?? (status === "failed" ? String(output.status) : undefined),
    )
    for (const source of [...list(action.sources), ...list(output.sources)]) addSource(source, id)
    for (const entry of list(output.outputs)) {
      if (entry.type === "image") addSource(record(entry.image), id)
    }
  }

  for (const [index, block] of content.entries()) {
    if (block.type !== "server_tool_use" || block.name !== "web_search") continue
    const id = string(block.id)
    if (!id) continue
    const deltas = content.filter(
      (part) => part.type === "input_json_delta" && part.index === (block.index ?? index),
    )
    const partial = deltas
      .map((part) => string(part.partial_json) ?? string(part.input) ?? "")
      .join("")
    let input: unknown = block.input ?? {}
    if (partial) {
      try {
        input = JSON.parse(partial)
      } catch {
        input = partial
      }
    }
    addCall(id, "web_search", input, "anthropic", "running")
  }
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue
    const id = string(block.tool_use_id)
    if (!id) continue
    const call = calls.get(id)
    const errorCode = string(record(block.content).error_code)
    addCall(
      id,
      "web_search",
      call?.input ?? {},
      "anthropic",
      errorCode ? "failed" : "completed",
      errorCode ?? "Search completed",
      errorCode,
    )
    for (const source of list(block.content)) addSource(source, id)
  }

  for (const block of content) {
    const invocation = record(block.toolCall)
    const response = record(block.toolResponse)
    if (
      invocation.toolType === "GOOGLE_SEARCH_WEB" ||
      invocation.toolType === "GOOGLE_SEARCH_IMAGE"
    ) {
      const id = string(invocation.id)
      if (id) addCall(id, "web_search", invocation.args ?? {}, "google", "running")
    }
    if (response.toolType === "GOOGLE_SEARCH_WEB" || response.toolType === "GOOGLE_SEARCH_IMAGE") {
      const id = string(response.id)
      const call = id ? calls.get(id) : undefined
      const output = record(response.response)
      if (call)
        addCall(
          call.id,
          "web_search",
          call.input,
          "google",
          output.error ? "failed" : "completed",
          string(output.output) ?? string(record(output.error).message) ?? "Search completed",
        )
    }
  }

  let codeOrdinal = 0
  let codeId: string | undefined
  for (const block of content) {
    if (Object.keys(record(block.executableCode)).length) {
      codeId = `${options.messageId}:code:${codeOrdinal++}`
      addCall(codeId, "code_execution", block.executableCode, "google", "running")
    }
    if (codeId && Object.keys(record(block.codeExecutionResult)).length) {
      const result = record(block.codeExecutionResult)
      const call = calls.get(codeId)
      const status = result.outcome === "OUTCOME_OK" ? "completed" : "failed"
      addCall(
        codeId,
        "code_execution",
        call?.input ?? {},
        "google",
        status,
        string(result.output),
        status === "failed" ? string(result.outcome) : undefined,
      )
    }
  }

  function citation(value: RecordValue, block: number): void {
    const nested = record(value.url_citation ?? value.file_citation)
    const raw = Object.keys(nested).length ? { ...value, ...nested } : value
    const source = addSource(raw)
    if (!source) return
    const start = offset(raw.start_index ?? raw.startIndex ?? raw.start)
    const end = offset(raw.end_index ?? raw.endIndex ?? raw.end)
    const quote = string(raw.cited_text) ?? string(raw.citedText) ?? string(raw.quote)
    const entry = {
      sourceId: source.id,
      block,
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(quote ? { quote } : {}),
    }
    if (!citations.some((previous) => JSON.stringify(previous) === JSON.stringify(entry)))
      citations.push(entry)
  }
  const outputTexts = outputs.flatMap((output) =>
    list(output.content).filter((block) => block.type === "text" || block.type === "output_text"),
  )
  const texts = outputTexts.length
    ? outputTexts
    : content.filter((block) => block.type === "text" || block.type === "output_text")
  for (const [index, block] of texts.entries()) {
    for (const entry of [...list(block.annotations), ...list(block.citations)])
      citation(entry, index)
  }
  // Anthropic v1 converts encrypted indices into numeric offsets. Match those
  // lossy copies one-for-one; ordinary citations deduplicate by full occurrence.
  const nativeOccurrences = [...citations]
  const encryptedCopies = texts.flatMap((block, index) =>
    [...list(block.annotations), ...list(block.citations)]
      .filter((entry) => entry.encrypted_index !== undefined)
      .map((entry) => `${index}:${entry.url}:${entry.cited_text ?? ""}`),
  )
  for (const [index, block] of standardized.filter((block) => block.type === "text").entries()) {
    for (const entry of [...list(block.annotations), ...list(block.citations)]) {
      const fileId = string(entry.file_id) ?? string(entry.fileId)
      if (fileId && entry.container_id === undefined && entry.containerId === undefined) {
        const start = offset(entry.start_index ?? entry.startIndex ?? entry.start)
        const end = offset(entry.end_index ?? entry.endIndex ?? entry.end)
        const quote = string(entry.cited_text) ?? string(entry.citedText) ?? string(entry.quote)
        const candidates = new Set(
          nativeOccurrences
            .filter(
              (occurrence) =>
                occurrence.block === index &&
                occurrence.start === start &&
                occurrence.end === end &&
                occurrence.quote === quote &&
                [
                  ...sources,
                  ...[...calls.values()].flatMap((call) => call.step.sources ?? []),
                ].some((source) => source.id === occurrence.sourceId && source.fileId === fileId),
            )
            .map((occurrence) => occurrence.sourceId),
        )
        if (candidates.size === 1) continue
      }
      const key = `${index}:${entry.url}:${entry.cited_text ?? entry.citedText ?? entry.quote ?? ""}`
      const encryptedCopy = encryptedCopies.indexOf(key)
      if (encryptedCopy >= 0) {
        encryptedCopies.splice(encryptedCopy, 1)
        continue
      }
      citation(entry, index)
    }
  }
  for (const grounding of [
    record(metadata.groundingMetadata ?? metadata.grounding_metadata),
    record(additional.groundingMetadata ?? additional.grounding_metadata),
  ]) {
    const groundingSources = list(grounding.groundingChunks).map((chunk) =>
      addSource(record(chunk.web ?? chunk.retrievedContext)),
    )
    for (const support of list(grounding.groundingSupports)) {
      const segment = record(support.segment)
      for (const index of Array.isArray(support.groundingChunkIndices)
        ? support.groundingChunkIndices
        : []) {
        const source = typeof index === "number" ? groundingSources[index] : undefined
        if (!source) continue
        const start = offset(segment.startIndex)
        const end = offset(segment.endIndex)
        const entry = {
          sourceId: source.id,
          ...(start !== undefined ? { start } : {}),
          ...(end !== undefined ? { end } : {}),
        }
        if (!citations.some((previous) => JSON.stringify(previous) === JSON.stringify(entry)))
          citations.push(entry)
      }
    }
    const html = string(record(grounding.searchEntryPoint).renderedContent)
    if (html && !attribution.some((entry) => entry.html === html))
      attribution.push({ provider: "google", kind: "search-suggestions", html, mustRender: true })
  }
  const answer =
    sources.length || citations.length || attribution.length || savedAnswer
      ? {
          v: 1 as const,
          ...(sources.length ? { sources } : {}),
          ...(citations.length ? { citations } : {}),
          ...(attribution.length ? { attribution } : {}),
        }
      : undefined
  return { calls: [...calls.values()], ...(answer ? { answer } : {}) }
}
