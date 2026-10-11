/**
 * Reading a tool's result as the workbench receives it: JSON text holding the
 * object the tool returned, either bare or wrapped as `{ result: … }`. Every
 * selector that reads a tool result unwraps it here, so they all accept both.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * The object a tool returned, from its JSON result text: the `{ result }`
 * envelope's contents when it has one, the parsed object otherwise. Null for
 * text that is not JSON or not an object.
 */
export function parseToolResult(text: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const candidate =
    isRecord(parsed) && "result" in parsed && isRecord(parsed.result) ? parsed.result : parsed
  return isRecord(candidate) ? candidate : null
}
