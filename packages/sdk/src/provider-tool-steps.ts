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
  web_fetch: "Fetching page",
  code_execution: "Running code",
  image_generation: "Generating an image",
}
const completedLabels: Readonly<Record<string, string>> = {
  web_search: "Searched the web",
  web_fetch: "Fetched page",
  code_execution: "Ran code",
  image_generation: "Generated image",
}
const toolNames: Readonly<Record<string, string>> = {
  web_search: "Web search",
  web_fetch: "Page fetch",
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
  const messageId = string(data.id) ?? options.messageId
  const additional = record(data.additional_kwargs)
  const metadata = record(data.response_metadata)
  const calls = new Map<string, ProviderToolCall>()
  const nativeIds = new Set<string>()
  const savedIds = new Set<string>()
  const savedAnswer = readAnswerAnnotations(additional.b4_answer)
  const sources: B4StepSource[] = [...(savedAnswer?.sources ?? [])]
  type Citation = NonNullable<B4AnswerAnnotations["citations"]>[number]
  const citations: Citation[] = []
  const citationLayouts = new Map<Citation, readonly RecordValue[]>()
  const attribution: NonNullable<B4AnswerAnnotations["attribution"]>[number][] = [
    ...(savedAnswer?.attribution ?? []),
  ]
  const content = list(data.content)
  const standardized = list(data.contentBlocks)
  const googleCandidates = list(additional.b4_google_raw_candidates).map((entry) =>
    record(entry.candidate),
  )
  const googleCitations =
    options.provider === "google" ||
    metadata.model_provider === "google" ||
    metadata.model_provider === "google-genai" ||
    googleCandidates.length > 0
  const googleParts = googleCandidates.length
    ? googleCandidates.flatMap((candidate) => list(record(candidate.content).parts))
    : content

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
    const builtin = name === "web_fetch" && provider === "google" ? "web_fetch" : builtins[name]
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
    const effectiveStep =
      firstNative && !savedIds.has(id) ? step : mergeToolStep(previous?.step, step, "message")
    const hasResultEvidence = result !== undefined || status === "failed" || status === "completed"
    const readableResult = hasResultEvidence
      ? effectiveStep.status === "failed"
        ? effectiveStep.error?.message
        : (result ?? (effectiveStep.status === "completed" ? "Completed" : undefined))
      : undefined
    calls.set(id, {
      id,
      name: builtin,
      input: normalizedInput,
      step: effectiveStep,
      ...(readableResult !== undefined ? { result: readableResult } : {}),
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
      id: `${owner ?? messageId}:source:${ownSources.length}`,
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

  const googleTools: Readonly<Record<string, string>> = {
    GOOGLE_SEARCH_WEB: "web_search",
    GOOGLE_SEARCH_IMAGE: "web_search",
    URL_CONTEXT: "web_fetch",
  }
  const googleInvocationTypes = new Map<string, string>()
  for (const block of googleParts) {
    const invocation = record(block.toolCall)
    const response = record(block.toolResponse)
    const name = googleTools[String(invocation.toolType)]
    const id = string(invocation.id)
    if (name && id) {
      googleInvocationTypes.set(id, String(invocation.toolType))
      addCall(id, name, invocation.args ?? {}, "google", "running")
    }
    const responseName = googleTools[String(response.toolType)]
    const responseId = string(response.id)
    const call = responseId ? calls.get(responseId) : undefined
    const output = record(response.response)
    if (responseName && call && googleInvocationTypes.get(call.id) === response.toolType) {
      const nativeError = record(output.error)
      const nativeCode =
        typeof nativeError.code === "number" ? String(nativeError.code) : string(nativeError.code)
      let failure: { message: string; code?: string } | undefined = output.error
        ? {
            message:
              string(output.error) ??
              string(nativeError.message) ??
              nativeCode ??
              "Provider tool failed",
            ...(nativeCode ? { code: nativeCode } : {}),
          }
        : output.status === "ERROR" || output.status === "FAILED"
          ? {
              message: string(output.message) ?? "Google tool execution failed",
              code: String(output.status),
            }
          : undefined
      if (responseName === "web_fetch") {
        for (const retrieval of list(output.url_metadata ?? output.urlMetadata)) {
          const uri = string(retrieval.retrieved_url ?? retrieval.retrievedUrl)
          const status = retrieval.url_retrieval_status ?? retrieval.urlRetrievalStatus
          if (uri && status === "URL_RETRIEVAL_STATUS_SUCCESS") addSource({ uri }, call.id)
          if (
            [
              "URL_RETRIEVAL_STATUS_ERROR",
              "URL_RETRIEVAL_STATUS_PAYWALL",
              "URL_RETRIEVAL_STATUS_UNSAFE",
            ].includes(String(status))
          ) {
            failure ??= {
              message: `Could not retrieve ${uri ?? "the requested URL"} (${status})`,
              code: String(status),
            }
          }
        }
      }
      addCall(
        call.id,
        responseName,
        call.input,
        "google",
        failure ? "failed" : "completed",
        failure?.message ??
          string(output.output) ??
          (responseName === "web_fetch" ? "Page fetched" : "Search completed"),
        failure?.code,
      )
      for (const source of list(output.sources)) addSource(source, call.id)
      const html =
        string(output.search_suggestions) ??
        string(record(output.search_suggestions).renderedContent)
      if (html && !attribution.some((entry) => entry.html === html))
        attribution.push({ provider: "google", kind: "search-suggestions", html, mustRender: true })
    }
  }

  for (const candidate of [metadata, additional, ...googleCandidates]) {
    for (const retrieval of list(record(candidate.urlContextMetadata).urlMetadata)) {
      if (retrieval.urlRetrievalStatus !== "URL_RETRIEVAL_STATUS_SUCCESS") continue
      const uri = string(retrieval.retrievedUrl)
      if (!uri) continue
      const owner = [...calls.values()].find((call) => {
        const urls = record(call.input).urls
        return (
          call.step.provider === "google" &&
          call.name === "web_fetch" &&
          Array.isArray(urls) &&
          urls.includes(uri)
        )
      })
      addSource({ uri }, owner?.id)
    }
  }

  let codeOrdinal = 0
  const googleCodeIds = new Set<string>()
  for (const block of googleParts) {
    const executable = record(block.executableCode)
    if (Object.keys(executable).length) {
      const generatedId = `${messageId}:code:${codeOrdinal++}`
      const codeId = string(executable.id) ?? generatedId
      googleCodeIds.add(codeId)
      addCall(codeId, "code_execution", block.executableCode, "google", "running")
    }
    const result = record(block.codeExecutionResult)
    if (!Object.keys(result).length) continue
    if (
      !["OUTCOME_OK", "OUTCOME_FAILED", "OUTCOME_DEADLINE_EXCEEDED"].includes(
        String(result.outcome),
      )
    )
      continue
    const resultId = string(result.id)
    const compatible = [...googleCodeIds].flatMap((id) => {
      const call = calls.get(id)
      return call && (resultId ? call.id === resultId : call.step.status === "running")
        ? [call]
        : []
    })
    if ((result.id !== undefined && !resultId) || compatible.length !== 1) continue
    const call = compatible[0]
    if (!call) continue
    const status = result.outcome === "OUTCOME_OK" ? "completed" : "failed"
    addCall(
      call.id,
      "code_execution",
      call.input,
      "google",
      status,
      string(result.output),
      status === "failed" ? String(result.outcome) : undefined,
    )
  }

  function citation(
    value: RecordValue,
    block: number,
    layout: readonly RecordValue[],
    nativeCopies?: Citation[],
  ): void {
    const nested = record(value.url_citation ?? value.file_citation)
    const raw = Object.keys(nested).length ? { ...value, ...nested } : value
    const source = addSource(raw)
    if (!source) return
    const start = googleCitations
      ? undefined
      : offset(raw.start_index ?? raw.startIndex ?? raw.start)
    const end = googleCitations ? undefined : offset(raw.end_index ?? raw.endIndex ?? raw.end)
    const quote = string(raw.cited_text) ?? string(raw.citedText) ?? string(raw.quote)
    const entry = {
      sourceId: source.id,
      block,
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(quote ? { quote } : {}),
    }
    const copy =
      nativeCopies?.findIndex((previous) => JSON.stringify(previous) === JSON.stringify(entry)) ??
      -1
    if (copy >= 0) {
      nativeCopies?.splice(copy, 1)
      return
    }
    citations.push(entry)
    citationLayouts.set(entry, layout)
  }
  const outputTexts = outputs.flatMap((output) =>
    list(output.content).filter((block) => block.type === "text" || block.type === "output_text"),
  )
  const texts = outputTexts.length
    ? outputTexts
    : content.filter((block) => block.type === "text" || block.type === "output_text")
  for (const [index, block] of texts.entries()) {
    for (const entry of [...list(block.annotations), ...list(block.citations)])
      citation(entry, index, texts)
  }
  // Anthropic v1 converts encrypted indices into numeric offsets. Match those
  // lossy copies one-for-one; ordinary citations deduplicate by full occurrence.
  const nativeOccurrences = [...citations]
  const nativeCopies = [...citations]
  const indexedFileCopies = texts.flatMap((block, index) =>
    [...list(block.annotations), ...list(block.citations)]
      .filter(
        (entry) =>
          entry.type === "file_citation" &&
          typeof entry.file_id === "string" &&
          offset(entry.index) !== undefined,
      )
      .map((entry) => ({
        key: `${index}:${entry.file_id}:${entry.index}`,
        container: string(entry.container_id),
      })),
  )
  const encryptedCopies = texts.flatMap((block, index) =>
    [...list(block.annotations), ...list(block.citations)]
      .filter((entry) => entry.encrypted_index !== undefined)
      .map((entry) => `${index}:${entry.url}:${entry.cited_text ?? ""}`),
  )
  const standardTexts = standardized.filter((block) => block.type === "text")
  for (const [index, block] of standardTexts.entries()) {
    for (const entry of [...list(block.annotations), ...list(block.citations)]) {
      const fileId = string(entry.file_id) ?? string(entry.fileId)
      if (fileId && entry.container_id === undefined && entry.containerId === undefined) {
        const start = offset(entry.start_index ?? entry.startIndex ?? entry.start)
        const end = offset(entry.end_index ?? entry.endIndex ?? entry.end)
        const quote = string(entry.cited_text) ?? string(entry.citedText) ?? string(entry.quote)
        if (start !== undefined && start === end) {
          const key = `${index}:${fileId}:${start}`
          const indexedCandidates = indexedFileCopies.filter((copy) => copy.key === key)
          const indexedCandidate = indexedCandidates[0]
          if (
            indexedCandidate &&
            new Set(indexedCandidates.map((copy) => copy.container)).size === 1
          ) {
            indexedFileCopies.splice(indexedFileCopies.indexOf(indexedCandidate), 1)
            continue
          }
        }
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
      citation(entry, index, standardTexts, nativeCopies)
    }
  }
  // Raw carrier coordinates have been reconciled above. The public message has
  // one text block, formed by joining assistant text with no separator.
  const contentTexts = content.filter(
    (block) => block.type === "text" || block.type === "output_text",
  )
  const joinText = (layout: readonly RecordValue[]): string =>
    layout.map((block) => (typeof block.text === "string" ? block.text : "")).join("")
  const publicText =
    typeof data.content === "string"
      ? data.content
      : contentTexts.length
        ? joinText(contentTexts)
        : googleCandidates.length
          ? joinText(
              googleParts.filter((part) => typeof part.text === "string" && part.thought !== true),
            )
          : joinText(standardTexts)
  for (let index = 0; index < citations.length; index++) {
    const entry = citations[index]
    if (!entry) continue
    const layout = citationLayouts.get(entry)
    const { block, start, end, ...identity } = entry
    const blockText = block !== undefined && layout ? layout[block]?.text : undefined
    const proven =
      layout?.every((part) => typeof part.text === "string") &&
      joinText(layout) === publicText &&
      typeof blockText === "string"
    const validSpan =
      proven &&
      start !== undefined &&
      end !== undefined &&
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start <= end &&
      end <= blockText.length
    const prefix =
      proven && block !== undefined ? joinText(layout?.slice(0, block) ?? []).length : 0
    citations[index] = {
      ...identity,
      ...(proven ? { block: 0 } : {}),
      ...(validSpan ? { start: prefix + start, end: prefix + end } : {}),
    }
  }

  for (const candidate of [metadata, additional, ...googleCandidates]) {
    const citationMetadata = record(candidate.citationMetadata ?? candidate.citation_metadata)
    const candidateParts = list(record(candidate.content).parts)
    const candidateText = candidateParts.length
      ? joinText(candidateParts.filter((part) => part.thought !== true))
      : publicText
    for (const native of list(
      citationMetadata.citationSources ?? citationMetadata.citation_sources,
    )) {
      const source = addSource(native)
      if (!source) continue
      // Citation metadata offsets are UTF-8 bytes. Keep a verified quote only;
      // no byte offset becomes an assistant character position.
      const start = offset(native.startIndex ?? native.start_index)
      const end = offset(native.endIndex ?? native.end_index)
      let quote = string(native.quote) ?? string(native.text)
      if (
        !quote &&
        start !== undefined &&
        end !== undefined &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start <= end
      ) {
        let byte = 0
        let character = 0
        let quoteStart: number | undefined
        let quoteEnd: number | undefined
        for (const point of candidateText) {
          if (byte === start) quoteStart = character
          if (byte === end) quoteEnd = character
          byte += new TextEncoder().encode(point).length
          character += point.length
        }
        if (byte === start) quoteStart = character
        if (byte === end) quoteEnd = character
        if (quoteStart !== undefined && quoteEnd !== undefined)
          quote = string(candidateText.slice(quoteStart, quoteEnd))
      }
      const entry = { sourceId: source.id, ...(quote ? { quote } : {}) }
      if (!citations.some((previous) => JSON.stringify(previous) === JSON.stringify(entry)))
        citations.push(entry)
    }
  }
  let groundingSources: (B4StepSource | undefined)[] = []
  for (const grounding of [
    record(metadata.groundingMetadata ?? metadata.grounding_metadata),
    record(additional.groundingMetadata ?? additional.grounding_metadata),
    ...googleCandidates.map((candidate) =>
      record(candidate.groundingMetadata ?? candidate.grounding_metadata),
    ),
  ]) {
    if (Array.isArray(grounding.groundingChunks) && grounding.groundingChunks.length)
      groundingSources = list(grounding.groundingChunks).map((chunk) =>
        addSource(record(chunk.web ?? chunk.retrievedContext)),
      )
    for (const support of list(grounding.groundingSupports)) {
      const segment = record(support.segment)
      for (const index of Array.isArray(support.groundingChunkIndices)
        ? support.groundingChunkIndices
        : []) {
        const source = typeof index === "number" ? groundingSources[index] : undefined
        if (!source) continue
        // Google segment offsets count UTF-8 bytes, not answer characters.
        const quote = string(segment.text)
        const entry = {
          sourceId: source.id,
          ...(quote ? { quote } : {}),
        }
        if (!citations.some((previous) => JSON.stringify(previous) === JSON.stringify(entry)))
          citations.push(entry)
      }
    }
    const html = string(record(grounding.searchEntryPoint).renderedContent)
    if (html && !attribution.some((entry) => entry.html === html))
      attribution.push({ provider: "google", kind: "search-suggestions", html, mustRender: true })
  }
  // Stored annotations already use public coordinates. Merge matching copies
  // one-for-one so repeated quote occurrences survive persist/restore.
  const unmatched = [...citations]
  for (const saved of savedAnswer?.citations ?? []) {
    const index = unmatched.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(saved))
    if (index >= 0) unmatched.splice(index, 1)
    else citations.push(saved)
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
