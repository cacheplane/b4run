import { spawnSync } from "node:child_process"
import type { JsonSchemaObject } from "../src/types.js"

/** Assertions stay in this process; target modules run only in the child. */
export function inspectTool(source: string, inputs: unknown[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "test/evaluate-tool.ts"], {
    input: JSON.stringify({ source, inputs }), encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw new Error(`Target execution failed: ${result.error ?? result.stderr}`)
  const parsed = JSON.parse(result.stdout) as { schema: JsonSchemaObject; accepted: boolean[] }
  if (!Array.isArray(parsed.accepted) || parsed.accepted.length !== inputs.length || parsed.accepted.some(value => typeof value !== "boolean")) throw new Error("Missing target results")
  return parsed
}
