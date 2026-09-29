import { describe, expect, test } from "vitest"

import { resolveDistillRetry } from "../src/lib/memory/distill-retry-config.js"

/**
 * `memory.distill.retry` has no runtime schema behind it, so every near miss
 * must fail with B4_E1009 rather than read as configured while the model keeps
 * the default. Each rejected case below is one guard in `resolveDistillRetry`.
 */

function rejection(memory: unknown): unknown {
  try {
    resolveDistillRetry(memory as never)
  } catch (error) {
    return error
  }
  return undefined
}

describe("resolveDistillRetry", () => {
  test.each([
    ["no memory block", undefined],
    ["memory without distill", {}],
    ["distill without retry", { distill: { model: "gpt-5-mini" } }],
    ["an empty retry", { distill: { retry: {} } }],
  ])("defaults to 3 attempts with %s", (_label, memory) => {
    expect(resolveDistillRetry(memory as never)).toEqual({ maxAttempts: 3 })
  })

  test.each([1, 3, 6])("honors maxAttempts %i", (maxAttempts) => {
    expect(resolveDistillRetry({ distill: { retry: { maxAttempts } } })).toEqual({ maxAttempts })
  })

  test("accepts every other known distill option alongside retry", () => {
    expect(
      resolveDistillRetry({
        distill: {
          model: "gpt-5-mini",
          provider: "openai",
          maxBatches: 2,
          consolidate: {},
          reflect: {},
          retry: { maxAttempts: 2 },
        },
      }),
    ).toEqual({ maxAttempts: 2 })
  })

  test.each([
    ["a non-object memory", "on", /memory must be an object; received "on"/],
    ["a non-object distill", { distill: true }, /memory\.distill must be an object; received true/],
    [
      "a non-object retry",
      { distill: { retry: 3 } },
      /memory\.distill\.retry must be an object; received 3/,
    ],
    [
      "retry misplaced on memory",
      { retry: { maxAttempts: 2 } },
      /retry belongs under memory\.distill, not memory directly/,
    ],
    [
      "maxAttempts misplaced on distill",
      { distill: { maxAttempts: 2 } },
      /maxAttempts belongs under memory\.distill\.retry/,
    ],
    [
      "a case typo of retry",
      { distill: { Retry: { maxAttempts: 2 } } },
      /Unknown memory\.distill option\(s\): Retry\. Known options: consolidate, maxBatches, model, provider, reflect, retry/,
    ],
    [
      "a case typo of maxAttempts",
      { distill: { retry: { maxattempts: 2 } } },
      /Unknown memory\.distill\.retry option\(s\): maxattempts\. Known options: maxAttempts/,
    ],
    [
      "baseDelay, which distillation never reads",
      { distill: { retry: { maxAttempts: 2, baseDelay: 500 } } },
      /memory\.distill\.retry\.baseDelay isn't supported/,
    ],
    [
      "a string maxAttempts",
      { distill: { retry: { maxAttempts: "3" } } },
      /maxAttempts must be a whole number of at least 1; received "3"/,
    ],
    ["maxAttempts 0", { distill: { retry: { maxAttempts: 0 } } }, /received 0\./],
    ["a fractional maxAttempts", { distill: { retry: { maxAttempts: 1.5 } } }, /received 1\.5\./],
    ["a negative maxAttempts", { distill: { retry: { maxAttempts: -1 } } }, /received -1\./],
    ["a NaN maxAttempts", { distill: { retry: { maxAttempts: Number.NaN } } }, /received NaN\./],
  ])("rejects %s with B4_E1009", (_label, memory, message) => {
    const error = rejection(memory)
    expect(error).toMatchObject({ code: "B4_E1009", exitCode: 1 })
    expect(String((error as Error).message)).toMatch(/^Invalid memory config:\n/)
    expect(String((error as Error).message)).toMatch(message)
  })
})
