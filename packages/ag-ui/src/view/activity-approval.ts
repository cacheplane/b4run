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
