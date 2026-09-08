/**
 * Type guards with no `node:` dependency, split out of `utils.ts` (which
 * reaches `node:fs`) so the `@b4run/cli/fetch` graph can use them.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
