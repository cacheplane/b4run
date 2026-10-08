/** The approval card's text (spec §3.2), framework-free: both activity kits render it. */

/** The three decisions an approval card offers. */
export type ApprovalDecision = "once" | "always" | "deny"

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

/**
 * A subagent dispatch gate's detail (`kind: "subagent"`: `subagentName`,
 * `subagentRouteId`, `inputPreview`, `reason`) as labelled lines, or undefined
 * when the detail names no subagent.
 */
function subagentPayload(detail: Readonly<Record<string, unknown>>): string | undefined {
  const name = text(detail.subagentName)
  if (name === undefined) return undefined
  const route = text(detail.subagentRouteId)
  const input = text(detail.inputPreview)
  const reason = text(detail.reason)
  return [
    `Subagent: ${route !== undefined ? `${name} (${route})` : name}`,
    ...(input !== undefined ? [`Input: ${input}`] : []),
    ...(reason !== undefined ? [`Reason: ${reason}`] : []),
  ].join("\n")
}

/**
 * `detail.argsPreview`, else the command, else a subagent gate's name, input
 * and reason, else the detail as JSON without the scope hint; "No details"
 * when nothing is left or it cannot be serialised.
 */
export function approvalPayload(detail: Readonly<Record<string, unknown>>): string {
  const preview = text(detail.argsPreview) ?? text(detail.command) ?? subagentPayload(detail)
  if (preview !== undefined) return preview
  const { suggestedPattern: _omit, ...rest } = detail
  try {
    const json = JSON.stringify(rest, null, 2)
    return json === undefined || json === "{}" ? "No details" : json
  } catch {
    return "No details"
  }
}

/** One argument of a gated tool call, as the approval card lists it. */
export interface ApprovalArgRow {
  /** The argument's name; a nested object's keys read `parent.key`. */
  readonly key: string
  /** The value on one line, cut at `MAX_APPROVAL_ARG_CHARS` with an ellipsis. */
  readonly value: string
  /** The whole value, only when `value` is cut: the card shows it on expand. */
  readonly full?: string
}

/** An argument value longer than this, or spanning lines, is cut; the card offers the rest. */
export const MAX_APPROVAL_ARG_CHARS = 80

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A value as text: a string as it is, null as "—", a scalar list joined, anything deeper as compact JSON. */
function argText(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== "object")) {
    return value.length === 0 ? "—" : value.map(argText).join(", ")
  }
  if (isPlainObject(value) && Object.keys(value).length === 0) return "—"
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function argRow(key: string, value: unknown): ApprovalArgRow {
  const text = argText(value)
  const chars = [...text]
  const firstLine = text.split("\n", 1)[0] ?? ""
  if (chars.length <= MAX_APPROVAL_ARG_CHARS && firstLine.length === text.length) {
    return { key, value: text }
  }
  const head = [...firstLine].slice(0, MAX_APPROVAL_ARG_CHARS).join("").trimEnd()
  return { key, value: `${head}…`, full: text }
}

/**
 * A gated tool call's arguments as rows (`key`, `value`), when the card shows
 * them: the detail's `argsPreview` is what the card would print (it wins over
 * `command` and a subagent gate's lines, as in `approvalPayload`) and it is a
 * JSON object with at least one key. A nested object's keys become one row
 * each, `parent.key`; anything deeper is compact JSON. A long value is cut,
 * with the whole of it in `full`. Undefined otherwise — a preview the server
 * cut short is no longer JSON — and the card prints `approvalPayload`.
 */
export function approvalArgsRows(
  detail: Readonly<Record<string, unknown>>,
): readonly ApprovalArgRow[] | undefined {
  const preview = text(detail.argsPreview)
  if (preview === undefined) return undefined
  let args: unknown
  try {
    args = JSON.parse(preview)
  } catch {
    return undefined
  }
  if (!isPlainObject(args) || Object.keys(args).length === 0) return undefined
  const rows: ApprovalArgRow[] = []
  for (const [key, value] of Object.entries(args)) {
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      for (const [inner, leaf] of Object.entries(value)) rows.push(argRow(`${key}.${inner}`, leaf))
    } else {
      rows.push(argRow(key, value))
    }
  }
  return rows
}

/** The sentence under the buttons that says what "Always allow" covers (spec §3.2). */
export function scopeLine(kind: string, detail: Readonly<Record<string, unknown>>): string {
  if (detail.scope === "thread") return "“Always allow” applies in this conversation only."
  const pattern = text(detail.suggestedPattern)
  if (kind === "command") return "“Always allow” applies to this exact command, for this app."
  if (pattern !== undefined)
    return `“Always allow” applies to every call of ${pattern}, for this app.`
  if (kind === "tool") return "“Always allow” applies to every call of this tool, for this app."
  return "“Always allow” applies to this exact command, for this app."
}

/** The line a card shows when its decision could not be sent, given the failure's message. */
export function approvalErrorLine(message: string): string {
  return `Couldn't send your decision: ${message}`
}

/**
 * Runs `decide` on the click itself (the executor is synchronous) and reports
 * a synchronous throw or a rejection, as the message to show, through `onError`.
 */
export function dispatchDecision(
  decide: () => Promise<void> | void,
  onError: (message: string) => void,
): void {
  new Promise<void>((resolve) => resolve(decide())).catch((cause: unknown) => {
    onError(cause instanceof Error ? cause.message : String(cause))
  })
}
