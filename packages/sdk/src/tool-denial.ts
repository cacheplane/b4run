/**
 * The brand a permission or constraint wrapper puts on a denied tool call.
 *
 * A denied call still RETURNS its reason as the tool result (the model reads it
 * as a regular result and adapts), but the runtime needs to tell a denial from
 * a result that happens to be a string: a tool's `display.done` must not
 * describe a denial as a success, and a step must not claim the call did its
 * work. The brand is a symbol key, so the value still has exactly one
 * enumerable key, `result`, and any consumer that only knows the `{result}`
 * wrapper shape reads the same string.
 *
 * `Symbol.for` keeps the brand stable across duplicate copies of this module.
 */
export const TOOL_DENIAL: unique symbol = Symbol.for("b4run.toolDenial") as never

/** A denied tool call's result: the text the model receives, branded. */
export interface ToolDenial {
  readonly [TOOL_DENIAL]: true
  readonly result: string
}

/** Brand a denial reason as a tool result. */
export function toolDenial(reason: string): ToolDenial {
  return { [TOOL_DENIAL]: true, result: reason }
}

/** Whether a tool's return value is a branded denial. */
export function isToolDenial(value: unknown): value is ToolDenial {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [TOOL_DENIAL]?: unknown })[TOOL_DENIAL] === true &&
    typeof (value as { result?: unknown }).result === "string"
  )
}
