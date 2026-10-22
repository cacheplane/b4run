import { TOOL_DISPLAY_LABEL_MAX } from "./tool-display.js"

/** Message-metadata key a tool call's step travels under. */
export const B4_STEP_METADATA_KEY = "b4.step"
/** Message-metadata key a final answer's annotations travel under. */
export const B4_ANSWER_METADATA_KEY = "b4.answer"
/** The AG-UI `CUSTOM` event name a live step travels as. */
export const B4_STEP_EVENT_NAME = "b4.step"
/** The contract's major version. Additive changes never bump it. */
export const B4_STEP_VERSION = 1

/** Every step status. A consumer treats an unknown string as "use the event lifecycle". */
export const B4_TOOL_STEP_STATUSES = [
  "running",
  "completed",
  "failed",
  "denied",
  "cancelled",
] as const

export type B4ToolStepStatus = (typeof B4_TOOL_STEP_STATUSES)[number]

/** Recommended `builtin` values. The field itself stays an open string. */
export const B4_BUILTIN_TOOLS = [
  "web_search",
  "web_fetch",
  "code_execution",
  "file_search",
  "mcp",
  "grounding",
  "tool_search",
  "image_generation",
] as const

/** A file, URL, document or record a step or answer drew on. */
export interface B4StepSource {
  /** Stable within the thread; citations reference it. */
  readonly id: string
  readonly kind: "url" | "file" | "document" | "record"
  readonly title: string
  readonly href?: string
  readonly snippet?: string
  readonly fileId?: string
  readonly containerId?: string
  /** E.g. OpenAI lists uncited URLs too. */
  readonly cited?: boolean
}

/** One tool call's human-readable, versioned step (`b4.step`). */
export interface B4ToolStep {
  readonly v: 1
  /** Required on the CUSTOM event only. */
  readonly toolCallId?: string
  /** Agent/app server vs model provider. */
  readonly kind: "server" | "provider"
  readonly builtin?: string
  readonly provider?: string
  readonly status: B4ToolStepStatus
  /** Plain text, at most 120 code points. */
  readonly label?: string
  readonly icon?: string
  readonly queries?: readonly string[]
  readonly sources?: readonly B4StepSource[]
  /** Epoch ms, producer clock, execution start. */
  readonly startedAt?: number
  /** Epoch ms. */
  readonly settledAt?: number
  readonly parentToolCallId?: string
  /** Present iff `status === "failed"`. */
  readonly error?: { readonly message: string; readonly code?: string }
  readonly decision?: "once" | "always" | "deny"
}

/**
 * What {@link readToolStep} returns: a step whose `status` may be absent
 * because the producer sent one this reader does not know. The caller falls
 * back to the lifecycle the events give; a merge never changes status for it.
 */
export type B4ToolStepRead = Omit<B4ToolStep, "status"> & {
  readonly status?: B4ToolStepStatus
}

/**
 * What {@link readToolStepUpdate} returns: like {@link B4ToolStepRead}, but
 * `kind` is absent when the source did not state it, so a merge keeps the
 * stored kind. {@link B4ToolStepRead} is assignable to it.
 */
export type B4ToolStepUpdate = Omit<B4ToolStep, "status" | "kind"> & {
  readonly status?: B4ToolStepStatus
  readonly kind?: B4ToolStep["kind"]
}

/** Annotations on a final answer (`b4.answer`). */
export interface B4AnswerAnnotations {
  readonly v: 1
  readonly citations?: ReadonlyArray<{
    readonly sourceId: string
    readonly quote?: string
    readonly block?: number
    readonly start?: number
    readonly end?: number
  }>
  /** Grounding that comes with no tool call (Gemini, Nova). */
  readonly sources?: readonly B4StepSource[]
  readonly attribution?: ReadonlyArray<{
    readonly provider: "google"
    readonly kind: "search-suggestions" | "maps"
    readonly html?: string
    readonly widgetToken?: string
    /** Show unmodified, adjacent, full width, no link tracking. */
    readonly mustRender: true
  }>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const STATUSES: readonly string[] = B4_TOOL_STEP_STATUSES
const SOURCE_KINDS: readonly string[] = ["url", "file", "document", "record"]
const DECISIONS: readonly string[] = ["once", "always", "deny"]

function readTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value !== "") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

function readLabel(value: unknown): string | undefined {
  const text = str(value)
  if (text === undefined) return undefined
  const points = Array.from(text)
  return points.length > TOOL_DISPLAY_LABEL_MAX
    ? points.slice(0, TOOL_DISPLAY_LABEL_MAX).join("")
    : text
}

function readSource(value: unknown, fallbackId: string): B4StepSource | undefined {
  if (!isRecord(value)) return undefined
  const title = str(value.title)
  if (title === undefined) return undefined
  const href = str(value.href)
  const kind =
    typeof value.kind === "string" && SOURCE_KINDS.includes(value.kind)
      ? (value.kind as B4StepSource["kind"])
      : href !== undefined
        ? "url"
        : "record"
  const snippet = str(value.snippet)
  const fileId = str(value.fileId)
  const containerId = str(value.containerId)
  return {
    id: str(value.id) ?? fallbackId,
    kind,
    title,
    ...(href !== undefined ? { href } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(fileId !== undefined ? { fileId } : {}),
    ...(containerId !== undefined ? { containerId } : {}),
    ...(typeof value.cited === "boolean" ? { cited: value.cited } : {}),
  }
}

function readSources(value: unknown, idPrefix: string): readonly B4StepSource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sources: B4StepSource[] = []
  value.forEach((entry, index) => {
    const source = readSource(entry, `${idPrefix}:${index}`)
    if (source !== undefined) sources.push(source)
  })
  return sources
}

/**
 * Reads a v1 step, a legacy `B4StepEventValue` or a legacy `PersistedStep`
 * into the v1 shape. Returns `undefined` for a non-record, a value with no
 * string `status`, or a `v` other than 1 (another major version is no step; a
 * value with no `v` is legacy). An unknown status string yields a step
 * without `status`. Unknown fields are ignored. `toolCallId` is the fallback
 * id for the step.
 */
export function readToolStep(value: unknown, toolCallId?: string): B4ToolStepRead | undefined {
  const update = readToolStepUpdate(value, toolCallId)
  return update === undefined ? undefined : { ...update, kind: update.kind ?? "server" }
}

/**
 * Like {@link readToolStep}, but leaves `kind` out when the source states
 * none. Use it for the `next` argument of {@link mergeToolStep}, so a sparse
 * legacy value cannot turn a stored `provider` step into a `server` one.
 * Like {@link readToolStep}, it returns `undefined` for a `v` other than 1.
 */
export function readToolStepUpdate(
  value: unknown,
  toolCallId?: string,
): B4ToolStepUpdate | undefined {
  if (!isRecord(value)) return undefined
  // Another major version travels under its own key; it is no v1 step.
  if (value.v !== undefined && value.v !== B4_STEP_VERSION) return undefined
  if (typeof value.status !== "string") return undefined
  const status = STATUSES.includes(value.status) ? (value.status as B4ToolStepStatus) : undefined
  const id = str(value.toolCallId) ?? toolCallId
  const label = readLabel(value.label)
  const builtin = str(value.builtin)
  const provider = str(value.provider)
  const icon = str(value.icon)
  const queries = Array.isArray(value.queries)
    ? value.queries.filter((q): q is string => typeof q === "string")
    : undefined
  const sources = readSources(value.sources, id ?? "step")
  const startedAt = readTime(value.startedAt)
  const settledAt = readTime(value.settledAt)
  const parent = str(value.parentToolCallId)
  const message = isRecord(value.error) ? str(value.error.message) : undefined
  const code = isRecord(value.error) ? str(value.error.code) : undefined
  const decision =
    typeof value.decision === "string" && DECISIONS.includes(value.decision)
      ? (value.decision as "once" | "always" | "deny")
      : undefined
  return {
    v: 1,
    ...(id !== undefined ? { toolCallId: id } : {}),
    ...(value.kind === "provider" || value.kind === "server" ? { kind: value.kind } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(builtin !== undefined ? { builtin } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(queries !== undefined ? { queries } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(settledAt !== undefined ? { settledAt } : {}),
    ...(parent !== undefined ? { parentToolCallId: parent } : {}),
    ...(status === "failed" && message !== undefined
      ? { error: { message, ...(code !== undefined ? { code } : {}) } }
      : {}),
    ...(decision !== undefined ? { decision } : {}),
  }
}

/** Reads `b4.answer` annotations, or `undefined` for a non-record or another major version. */
export function readAnswerAnnotations(value: unknown): B4AnswerAnnotations | undefined {
  if (!isRecord(value)) return undefined
  if (value.v !== undefined && value.v !== 1) return undefined
  const citations = Array.isArray(value.citations)
    ? value.citations.flatMap((entry) => {
        if (!isRecord(entry)) return []
        const sourceId = str(entry.sourceId)
        if (sourceId === undefined) return []
        const quote = str(entry.quote)
        const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : undefined)
        const block = num(entry.block)
        const start = num(entry.start)
        const end = num(entry.end)
        return [
          {
            sourceId,
            ...(quote !== undefined ? { quote } : {}),
            ...(block !== undefined ? { block } : {}),
            ...(start !== undefined ? { start } : {}),
            ...(end !== undefined ? { end } : {}),
          },
        ]
      })
    : undefined
  const sources = readSources(value.sources, "answer")
  const attribution = Array.isArray(value.attribution)
    ? value.attribution.flatMap((entry) => {
        if (!isRecord(entry) || entry.provider !== "google") return []
        if (entry.kind !== "search-suggestions" && entry.kind !== "maps") return []
        const html = str(entry.html)
        const widgetToken = str(entry.widgetToken)
        return [
          {
            provider: "google" as const,
            kind: entry.kind as "search-suggestions" | "maps",
            ...(html !== undefined ? { html } : {}),
            ...(widgetToken !== undefined ? { widgetToken } : {}),
            mustRender: true as const,
          },
        ]
      })
    : undefined
  return {
    v: 1,
    ...(citations !== undefined ? { citations } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(attribution !== undefined ? { attribution } : {}),
  }
}

const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "denied", "cancelled"])
const CLEARS_RUNNING: ReadonlySet<string> = new Set(["failed", "denied", "cancelled"])

const DEFAULT_FAILURE = "Tool call did not finish"

/** A failed step always carries an error; any other step never does. */
function withErrorRule(step: B4ToolStep): B4ToolStep {
  if (step.status === "failed") {
    return step.error === undefined ? { ...step, error: { message: DEFAULT_FAILURE } } : step
  }
  if (step.error === undefined) return step
  const { error: _error, ...rest } = step
  return rest
}

/**
 * Folds `next` into `previous` by the contract's merge rules and returns the
 * merged step; neither argument is mutated.
 *
 * Read `next` with {@link readToolStepUpdate}, not {@link readToolStep}: the
 * update leaves `kind` out when the source states none, so a sparse legacy
 * value never turns a stored `provider` step into a `server` one. `source` is
 * the carrier: `"message"` for the call's result (TOOL_CALL_RESULT metadata or
 * the ToolMessage), `"call"` for START/END metadata and CUSTOM events.
 *
 * Status:
 * - `failed` wins over every other status.
 * - `completed`, `denied` and `cancelled` settle a step that is still running.
 *   A settled step changes only for a `"message"` write, or for a move from
 *   `completed` into `denied` or `cancelled`.
 * - `running` only lifts an unsettled step. A `next` without a status never
 *   changes the status. With no `previous` and no status the step starts as
 *   `running`.
 *
 * Fields:
 * - A settle out of `running` drops the running-only `label` and `sources`
 *   unless `next` restates them; `icon`, `startedAt`, `queries`, `kind`,
 *   `builtin` and `provider` carry over.
 * - A move into a different bad status (`failed`, `denied`, `cancelled`) from
 *   `completed` does the same: `next`'s label and sources, or none.
 * - A `running` write never contributes fields to a settled step.
 * - Otherwise `next`'s defined fields merge over `previous`, and a
 *   `"message"` write beats a `"call"` write on a settled step.
 * - A failed step always carries `error`, defaulting to
 *   `{ message: "Tool call did not finish" }`; any other step carries none.
 */
export function mergeToolStep(
  previous: B4ToolStep | undefined,
  next: B4ToolStepUpdate,
  source: "call" | "message",
): B4ToolStep {
  if (previous === undefined) {
    return withErrorRule({ ...next, kind: next.kind ?? "server", status: next.status ?? "running" })
  }
  if (previous.status === "failed") return withErrorRule(previous)
  const prevSettled = SETTLED.has(previous.status)
  const { status: nextStatus, ...nextFields } = next
  // A running write says nothing about a step that has already settled.
  if (prevSettled && nextStatus === "running") return withErrorRule(previous)
  let status: B4ToolStepStatus = previous.status
  if (nextStatus === "failed") status = "failed"
  else if (nextStatus === "running") status = "running"
  else if (nextStatus !== undefined) {
    const badAfterCompleted = previous.status === "completed" && CLEARS_RUNNING.has(nextStatus)
    if (source === "message" || !prevSettled || badAfterCompleted) status = nextStatus
  }
  const settlesRunning = previous.status === "running" && SETTLED.has(status)
  const turnsBad = CLEARS_RUNNING.has(status) && status !== previous.status
  if (settlesRunning || turnsBad) {
    // What the step showed while it ran (or as it completed) no longer says
    // what happened: only what the settle itself restates stays.
    const { label: _label, sources: _sources, ...kept } = previous
    return withErrorRule({ ...kept, ...nextFields, status })
  }
  const nextWins = source === "message" || !prevSettled
  const merged: B4ToolStep = nextWins
    ? { ...previous, ...nextFields, status }
    : { ...nextFields, ...previous, status }
  return withErrorRule(merged)
}

/**
 * Settles every open (`running`) step at the end of a run: `failed` on a run
 * error, `cancelled` on a cancelled or interrupted run. Ids in `keepOpen`
 * (the pending tool calls of an interrupt) stay running. Returns a new record.
 */
export function settleOpenSteps(
  steps: Readonly<Record<string, B4ToolStep>>,
  outcome: "failed" | "cancelled",
  keepOpen: ReadonlySet<string>,
  at: number,
): Record<string, B4ToolStep> {
  const result: Record<string, B4ToolStep> = {}
  for (const [id, step] of Object.entries(steps)) {
    if (step.status !== "running" || keepOpen.has(id)) {
      result[id] = step
      continue
    }
    const { label: _label, sources: _sources, ...rest } = step
    result[id] = {
      ...rest,
      status: outcome,
      settledAt: at,
      ...(outcome === "failed" ? { error: { message: DEFAULT_FAILURE } } : {}),
    }
  }
  return result
}

const SOURCE_SCHEMA = {
  type: "object",
  required: ["id", "kind", "title"],
  properties: {
    id: { type: "string" },
    kind: { enum: ["url", "file", "document", "record"] },
    title: { type: "string" },
    href: { type: "string" },
    snippet: { type: "string" },
    fileId: { type: "string" },
    containerId: { type: "string" },
    cited: { type: "boolean" },
  },
  additionalProperties: true,
} as const

/** JSON Schema (draft 2020-12) for {@link B4ToolStep}. Unknown fields are allowed. */
export const B4_TOOL_STEP_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "B4ToolStep",
  type: "object",
  required: ["v", "kind", "status"],
  properties: {
    v: { const: 1 },
    toolCallId: { type: "string" },
    kind: { enum: ["server", "provider"] },
    builtin: { type: "string" },
    provider: { type: "string" },
    status: { enum: [...B4_TOOL_STEP_STATUSES] },
    label: { type: "string", maxLength: TOOL_DISPLAY_LABEL_MAX },
    icon: { type: "string" },
    queries: { type: "array", items: { type: "string" } },
    sources: { type: "array", items: SOURCE_SCHEMA },
    startedAt: { type: "number" },
    settledAt: { type: "number" },
    parentToolCallId: { type: "string" },
    error: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" }, code: { type: "string" } },
    },
    decision: { enum: ["once", "always", "deny"] },
  },
  additionalProperties: true,
} as const

/** JSON Schema (draft 2020-12) for {@link B4AnswerAnnotations}. Unknown fields are allowed. */
export const B4_ANSWER_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "B4AnswerAnnotations",
  type: "object",
  required: ["v"],
  properties: {
    v: { const: 1 },
    citations: {
      type: "array",
      items: {
        type: "object",
        required: ["sourceId"],
        properties: {
          sourceId: { type: "string" },
          quote: { type: "string" },
          block: { type: "number" },
          start: { type: "number" },
          end: { type: "number" },
        },
      },
    },
    sources: { type: "array", items: SOURCE_SCHEMA },
    attribution: {
      type: "array",
      items: {
        type: "object",
        required: ["provider", "kind", "mustRender"],
        properties: {
          provider: { const: "google" },
          kind: { enum: ["search-suggestions", "maps"] },
          html: { type: "string" },
          widgetToken: { type: "string" },
          mustRender: { const: true },
        },
      },
    },
  },
  additionalProperties: true,
} as const
