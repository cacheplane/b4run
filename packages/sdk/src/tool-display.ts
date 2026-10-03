/** The fixed step icons; `tool` is the default when a tool sets none. */
export const TOOL_DISPLAY_ICONS = [
  "search",
  "read",
  "write",
  "run",
  "web",
  "memory",
  "plan",
  "agent",
  "think",
  "tool",
] as const

export type ToolDisplayIcon = (typeof TOOL_DISPLAY_ICONS)[number]

/** A file, URL or record a call drew on; shown as a chip under the step. */
export interface ToolDisplaySource {
  readonly title: string
  readonly href?: string
}

/**
 * How a tool call reads to a person. A tool file exports `display` next to
 * `description`; the runtime evaluates it per call and streams the result as
 * an AG-UI `CUSTOM` event named `b4.step`, so a chat UI can say
 * "Searched the corpus for “agents”" instead of `searchCorpus`.
 *
 * Every field is optional. Without `running`/`done` a client falls back to
 * "Using <tool>…" / "Used <tool>". Labels are plain text; the runtime
 * truncates them at {@link TOOL_DISPLAY_LABEL_MAX} characters.
 */
// biome-ignore lint/suspicious/noExplicitAny: defaults widen to the tool's own input/output types
export interface ToolDisplay<TInput = any, TOutput = any> {
  readonly icon?: ToolDisplayIcon
  /** The sentence while the call runs, e.g. `Searching the corpus for “${query}”`. */
  readonly running?: (input: TInput) => string
  /** The sentence once it returned, e.g. `Searched the corpus for “${query}”`. */
  readonly done?: (input: TInput, output: TOutput) => string
  /** What the call drew on, from its output. */
  readonly sources?: (output: TOutput) => readonly ToolDisplaySource[]
}

export const TOOL_DISPLAY_LABEL_MAX = 120

const DISPLAY_KEYS = ["icon", "running", "done", "sources"] as const
const FUNCTION_KEYS = ["running", "done", "sources"] as const

export function isToolDisplayIcon(value: unknown): value is ToolDisplayIcon {
  return typeof value === "string" && (TOOL_DISPLAY_ICONS as readonly string[]).includes(value)
}

/** A bad value for an error message: strings quoted, everything else by type. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (value === null) return "null"
  return typeof value
}

/**
 * The first thing wrong with a `display` export, as a sentence, or undefined
 * when it is valid. Used by `b4 check` and the runtime's tool normalizer, so
 * a bad export fails at discovery rather than on the first call.
 */
export function describeToolDisplayProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "display must be an object"
  }
  try {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!(DISPLAY_KEYS as readonly string[]).includes(key)) {
        return `display has an unknown key "${key}" (allowed: ${DISPLAY_KEYS.join(", ")})`
      }
    }
    if (record.icon !== undefined && !isToolDisplayIcon(record.icon)) {
      return `display.icon must be one of ${TOOL_DISPLAY_ICONS.join(", ")} (got ${describeValue(record.icon)})`
    }
    for (const key of FUNCTION_KEYS) {
      const field = record[key]
      if (field !== undefined && typeof field !== "function") {
        return `display.${key} must be a function (got ${describeValue(field)})`
      }
    }
    return undefined
  } catch {
    return "display could not be read"
  }
}
