import type { B4Config } from "@b4run/core"
import { CliError } from "../output.js"

/** Every key `memory.distill` accepts. Anything else is an authoring error. */
const DISTILL_KEYS: readonly string[] = [
  "consolidate",
  "maxBatches",
  "model",
  "provider",
  "reflect",
  "retry",
]

/** Every key `memory.distill.retry` accepts. */
const DISTILL_RETRY_KEYS: readonly string[] = ["maxAttempts"]

const DEFAULT_MAX_ATTEMPTS = 3

export interface ResolvedDistillRetry {
  /** Attempts per distillation model call, counting the first. */
  readonly maxAttempts: number
}

function invalidMemoryConfig(detail: string): CliError {
  return new CliError(`Invalid memory config:\n${detail}`, 1, { code: "B4_E1009" })
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A value as the author wrote it (`NaN` stays `NaN`, not JSON's `null`). */
function describe(value: unknown): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value)
}

function ownProperty(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/**
 * Whether `candidate` (already lower-cased) is `target` up to one inserted,
 * deleted or substituted character: `distil`, `distills`, `distiIl`. Paired
 * with case folding, this catches the spellings of `distill` an author could
 * plausibly mean, without an allow-list of every `memory` key.
 */
function isNearMiss(candidate: string, target: string): boolean {
  if (candidate === target) return true
  const lengthGap = candidate.length - target.length
  if (Math.abs(lengthGap) > 1) return false
  const [longer, shorter] = lengthGap >= 0 ? [candidate, target] : [target, candidate]
  let i = 0
  while (i < shorter.length && longer[i] === shorter[i]) i += 1
  const tail = longer.length === shorter.length ? i + 1 : i
  return longer.slice(i + 1) === shorter.slice(tail)
}

/**
 * Validates `memory.distill` far enough to honor `memory.distill.retry`, and
 * returns the attempts the distillation model gets.
 *
 * `B4Config` has no runtime schema, and a `b4.config.js` (or an untyped
 * `export default {}`) gets no excess-property check, so a near miss would
 * otherwise read as configured while the model silently kept the default.
 * Rejected, with B4_E1009: a non-object `memory`, `memory.distill` or
 * `memory.distill.retry`; an unknown key in `memory.distill` (`Retry`) or in
 * `retry` (`maxattempts`); `baseDelay`, which nothing in distillation reads;
 * `retry` or `maxAttempts` (in any casing) directly on `memory`, or
 * `maxAttempts` directly on `memory.distill`; a key on `memory` that is
 * `distill` up to case and one character (`Distill`, `distil`, `distills`);
 * and a `maxAttempts` that isn't a whole number of at least 1.
 *
 * `b4 check` and `b4 memory consolidate`/`reflect` both call this, and the
 * model is built from the value it returns, so the validated shape and the
 * honored value cannot diverge.
 */
export function resolveDistillRetry(memory: B4Config["memory"] | undefined): ResolvedDistillRetry {
  if (memory === undefined) return { maxAttempts: DEFAULT_MAX_ATTEMPTS }
  if (!isRecord(memory)) {
    throw invalidMemoryConfig(`memory must be an object; received ${describe(memory)}.`)
  }
  for (const key of Object.keys(memory)) {
    const folded = key.toLowerCase()
    if (folded === "retry") {
      throw invalidMemoryConfig(
        `${key} belongs under memory.distill, not memory directly. Use memory: { distill: { retry: { maxAttempts: 3 } } }.`,
      )
    }
    if (folded === "maxattempts") {
      throw invalidMemoryConfig(
        `${key} belongs under memory.distill.retry, not memory directly. Use memory: { distill: { retry: { maxAttempts: 3 } } }.`,
      )
    }
    if (key !== "distill" && isNearMiss(folded, "distill")) {
      throw invalidMemoryConfig(
        `Unknown memory option: ${key}. Did you mean memory.distill? Rename it to distill, e.g. memory: { distill: { retry: { maxAttempts: 3 } } }.`,
      )
    }
  }

  const distill = ownProperty(memory, "distill")
  if (distill === undefined) return { maxAttempts: DEFAULT_MAX_ATTEMPTS }
  if (!isRecord(distill)) {
    throw invalidMemoryConfig(`memory.distill must be an object; received ${describe(distill)}.`)
  }
  if (ownProperty(distill, "maxAttempts") !== undefined) {
    throw invalidMemoryConfig(
      "maxAttempts belongs under memory.distill.retry, not memory.distill directly. Use memory: { distill: { retry: { maxAttempts: 3 } } }.",
    )
  }
  const unknownDistillKeys = Object.keys(distill)
    .filter((key) => !DISTILL_KEYS.includes(key))
    .sort()
  if (unknownDistillKeys.length > 0) {
    throw invalidMemoryConfig(
      `Unknown memory.distill option(s): ${unknownDistillKeys.join(", ")}. Known options: ${DISTILL_KEYS.join(", ")}.`,
    )
  }

  const retry = ownProperty(distill, "retry")
  if (retry === undefined) return { maxAttempts: DEFAULT_MAX_ATTEMPTS }
  if (!isRecord(retry)) {
    throw invalidMemoryConfig(
      `memory.distill.retry must be an object; received ${describe(retry)}.`,
    )
  }
  if (ownProperty(retry, "baseDelay") !== undefined) {
    throw invalidMemoryConfig(
      "memory.distill.retry.baseDelay isn't supported: distillation has no capacity rate-limit retry for it to pace. Remove it; maxAttempts is the only retry option here.",
    )
  }
  const unknownRetryKeys = Object.keys(retry)
    .filter((key) => !DISTILL_RETRY_KEYS.includes(key))
    .sort()
  if (unknownRetryKeys.length > 0) {
    throw invalidMemoryConfig(
      `Unknown memory.distill.retry option(s): ${unknownRetryKeys.join(", ")}. Known options: ${DISTILL_RETRY_KEYS.join(", ")}.`,
    )
  }

  const maxAttempts = ownProperty(retry, "maxAttempts")
  if (maxAttempts === undefined) return { maxAttempts: DEFAULT_MAX_ATTEMPTS }
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw invalidMemoryConfig(
      `memory.distill.retry.maxAttempts must be a whole number of at least 1; received ${describe(maxAttempts)}.`,
    )
  }
  return { maxAttempts }
}
