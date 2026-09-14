import { z } from "zod"
/** Redact before writing evidence, including nested provider/tool outputs. */
export function redactEvidence(value: unknown, secrets: string[], paths: string[]): unknown {
  if (typeof value === "string") {
    let result = value
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
      result = result.replaceAll(secret, "[redacted]")
    for (const path of paths.filter(Boolean).sort((a, b) => b.length - a.length))
      result = result.replaceAll(path, "[host-path]")
    return result
  }
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item, secrets, paths))
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactEvidence(item, secrets, paths)]),
    )
  return value
}

export function verdict(criteria: Record<string, boolean>, pending: boolean) {
  const required = ["visible", "independent", "scope", "reproduced", "verified", "approval"]
  const passed = required.every((key) => criteria[key] === true)
  return { passed, status: passed ? (pending ? "approval-pending" : "passed") : "failed" }
}

export function assertExportable(value: unknown): void {
  const check = z.object({
    passed: z.literal(true),
    exitCode: z.literal(0),
    receipt: z.object({
      events: z
        .array(
          z.object({
            type: z.literal("test:pass"),
            name: z.string().min(1),
            skip: z.literal(false),
            todo: z.literal(false),
          }),
        )
        .min(1),
    }),
  })
  const schema = z.object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    mode: z.literal("live"),
    passed: z.literal(true),
    agent: z.object({
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      dirty: z.literal(false),
      model: z.string().min(1),
    }),
    fixture: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
    image: z.string().startsWith("sha256:"),
    source: z.record(z.string(), z.string()),
    criteria: z.record(z.string(), z.boolean()),
    prepared: z.object({
      changes: z.record(z.string(), z.string()),
      verification: z.object({
        passed: z.literal(true),
        visible: check,
        independent: check,
      }),
    }),
    timings: z.object({
      runMs: z.number().nonnegative(),
      verificationMs: z.number().nonnegative(),
    }),
  })
  const parsed = schema.parse(value)
  if (!verdict(parsed.criteria, true).passed || Object.keys(parsed.source).length === 0)
    throw new Error("Incomplete recording criteria or source snapshot")
}

export function failureStatus(error: unknown) {
  if (error instanceof Error && error.name === "GraphRecursionError") return "step-limit"
  if (error instanceof Error && error.name === "PatchRejectedError") return "behavior-failed"
  return "infrastructure-failed"
}
