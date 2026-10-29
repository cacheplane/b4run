/** Recommended step icons with built-in glyphs; `tool` is the default when none is set. */
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

/** An opaque icon name; recommended names retain editor autocomplete. */
export type ToolDisplayIcon = (typeof TOOL_DISPLAY_ICONS)[number] | (string & {})

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
 * Every field is optional. Without `running`/`done`/`failed` a client falls
 * back to "Using <tool>…" / "Used <tool>" / "<tool> failed". Labels are plain
 * text; the runtime truncates them at {@link TOOL_DISPLAY_LABEL_MAX} characters.
 */
// biome-ignore lint/suspicious/noExplicitAny: defaults widen to the tool's own input/output types
export interface ToolDisplay<TInput = any, TOutput = any> {
  /** A nonempty, opaque name. Unknown names use the client's generic tool glyph. */
  readonly icon?: ToolDisplayIcon
  /** The sentence while the call runs, e.g. `Searching the corpus for “${query}”`. */
  readonly running?: (input: TInput) => string
  /**
   * The sentence once it returned, e.g. `Searched the corpus for “${query}”`.
   * `output` is the value the tool returned, exactly as returned — for a
   * `{ result, state }` tool that is the wrapper object, not `result`.
   */
  readonly done?: (input: TInput, output: TOutput) => string
  /**
   * The sentence when the call threw, e.g. `Couldn't search the corpus for “${query}”`.
   * `error` is the text the model was given for the failure. Without it a
   * client reads "<tool> failed".
   */
  readonly failed?: (input: TInput, error: string) => string
  /**
   * What the call drew on, from its output. `output` is the value the tool
   * returned, exactly as returned — for a `{ result, state }` tool that is the
   * wrapper object, not `result`.
   */
  readonly sources?: (output: TOutput) => readonly ToolDisplaySource[]
}

export const TOOL_DISPLAY_LABEL_MAX = 120

const DISPLAY_KEYS = ["icon", "running", "done", "failed", "sources"] as const
const FUNCTION_KEYS = ["running", "done", "failed", "sources"] as const

/** Tests membership in the recommended built-in glyph names, not validity of an authored icon. */
export function isToolDisplayIcon(value: unknown): value is (typeof TOOL_DISPLAY_ICONS)[number] {
  return typeof value === "string" && (TOOL_DISPLAY_ICONS as readonly string[]).includes(value)
}

const DESCRIBE_VALUE_MAX = 60

/**
 * A bad value for an error message: strings quoted (control characters,
 * quotes and backslashes escaped, long values cut), everything else by type.
 * The result is prose for a person, never code.
 */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    const shown =
      value.length > DESCRIBE_VALUE_MAX ? `${value.slice(0, DESCRIBE_VALUE_MAX)}…` : value
    let escaped = ""
    for (const char of shown) {
      const code = char.codePointAt(0) ?? 0
      if (char === "\\" || char === '"') escaped += `\\${char}`
      else if (code < 0x20 || code === 0x7f) escaped += `\\u${code.toString(16).padStart(4, "0")}`
      else escaped += char
    }
    return `"${escaped}"`
  }
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
    if (record.icon !== undefined && (typeof record.icon !== "string" || record.icon === "")) {
      return `display.icon must be a nonempty string (got ${describeValue(record.icon)})`
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
