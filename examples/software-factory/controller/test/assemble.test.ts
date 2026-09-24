import { describe, expect, it } from "vitest"
import { DigestInputError } from "../src/lib/domain/digest.ts"
import {
  AssemblyRejectedError,
  assembleCandidate,
  elisionIn,
} from "../src/lib/verification/assemble.ts"

const baseline = new Map([
  ["src/cli.ts", "broken\n"],
  ["test/cli.test.ts", "spec\n"],
  ["TASK.md", "task\n"],
])
const policy = {
  workspaceId: "cli-flags",
  baselineDigest: "a".repeat(64),
  allowedSourcePaths: ["src/cli.ts"],
  immutablePaths: ["test/cli.test.ts"],
  maxChangedBytes: 1024,
}

const observed = (over: Record<string, string>) => new Map([...baseline, ...Object.entries(over)])

describe("assembleCandidate", () => {
  it("returns only the changed allowed files and a digest over them", () => {
    const result = assembleCandidate({
      baseline,
      observed: observed({ "src/cli.ts": "fixed\n" }),
      policy,
    })
    expect(result.changes).toEqual({ "src/cli.ts": "fixed\n" })
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.bytes).toBe(Buffer.byteLength("fixed\n"))
    expect(result.changedPaths).toEqual(["src/cli.ts"])
  })

  it("is byte-identical for an unchanged workspace and reports no candidate", () => {
    expect(assembleCandidate({ baseline, observed: observed({}), policy }).changes).toEqual({})
  })

  it("rejects a change to an immutable path", () => {
    expect(() =>
      assembleCandidate({
        baseline,
        observed: observed({ "test/cli.test.ts": "weakened\n" }),
        policy,
      }),
    ).toThrow(AssemblyRejectedError)
  })

  it("rejects a change outside the allowed inventory even if it is not immutable", () => {
    expect(() =>
      assembleCandidate({ baseline, observed: observed({ "TASK.md": "rewritten\n" }), policy }),
    ).toThrow(/not in the allowed inventory/)
  })

  it("rejects an added path", () => {
    expect(() =>
      assembleCandidate({ baseline, observed: observed({ "src/extra.ts": "new\n" }), policy }),
    ).toThrow(/added/)
  })

  it("rejects a removed path", () => {
    const missing = new Map(baseline)
    missing.delete("src/cli.ts")
    expect(() => assembleCandidate({ baseline, observed: missing, policy })).toThrow(/removed/)
  })

  it("rejects a cap breach rather than truncating", () => {
    const big = "x".repeat(2048)
    expect(() =>
      assembleCandidate({ baseline, observed: observed({ "src/cli.ts": big }), policy }),
    ).toThrow(/exceeds/)
  })

  it("rejects content that is not valid text", () => {
    expect(() =>
      assembleCandidate({ baseline, observed: observed({ "src/cli.ts": "nul\0byte\n" }), policy }),
    ).toThrow(/NUL/)

    let caught: unknown
    try {
      assembleCandidate({ baseline, observed: observed({ "src/cli.ts": "nul\0byte\n" }), policy })
      throw new Error("expected a rejection")
    } catch (error) {
      caught = error
    }
    expect((caught as AssemblyRejectedError).rule).toBe("encoding")
  })

  it("rejects a lone surrogate as an encoding rejection, not a raw DigestInputError", () => {
    const loneSurrogate = "\uD800"
    let caught: unknown
    try {
      assembleCandidate({ baseline, observed: observed({ "src/cli.ts": loneSurrogate }), policy })
      throw new Error("expected a rejection")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AssemblyRejectedError)
    expect((caught as AssemblyRejectedError).rule).toBe("encoding")
    expect((caught as AssemblyRejectedError).cause).toBeInstanceOf(DigestInputError)
  })

  it("names the violated rule on the error so the controller can record a reason", () => {
    try {
      assembleCandidate({ baseline, observed: observed({ "TASK.md": "rewritten\n" }), policy })
      throw new Error("expected a rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(AssemblyRejectedError)
      expect((error as AssemblyRejectedError).rule).toBe("inventory")
    }
  })

  describe("the elision guard", () => {
    /** A baseline big enough for the shrink rule, whose lines are all distinct. */
    const large = Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i}`).join("\n")
    const rejection = (after: string, before = large) => {
      try {
        assembleCandidate({
          baseline: new Map([...baseline, ["src/cli.ts", before]]),
          observed: new Map([...baseline, ["src/cli.ts", after]]),
          policy: { ...policy, maxChangedBytes: 1024 * 1024 },
        })
      } catch (error) {
        if (error instanceof AssemblyRejectedError) return error
        throw error
      }
      return undefined
    }

    it("refuses the live run's truncation marker, naming the file and the line", () => {
      const lines = large.split("\n")
      const truncated = [...lines.slice(0, 150), "... (file truncated, unchanged)"].join("\n")
      const error = rejection(truncated)
      expect(error?.rule).toBe("elided")
      expect(error?.message).toContain("src/cli.ts")
      expect(error?.message).toContain("line 151")
    })

    it.each([
      "// ... rest of the file unchanged",
      "/* rest of file */",
      "...(truncated)",
      "  // (unchanged)",
    ])("refuses the placeholder %j", (placeholder) => {
      const lines = large.split("\n")
      expect(rejection([...lines.slice(0, 199), placeholder].join("\n"))?.rule).toBe("elided")
    })

    it.each([
      // packages/cli/src/lib/runtime/execute-route-core.ts:1190
      "      // per-request resolution (the testing harness path, unchanged).",
      // packages/cli/src/lib/dev/middleware-node.ts:104
      " *   • every candidate definitively absent      -> undefined (no gate; unchanged)",
      "const rest = [...items]",
      "  return { ...state, done: true }",
    ])("does not refuse code or prose that merely mentions it: %j", (line) => {
      const lines = large.split("\n")
      expect(rejection([...lines.slice(0, 199), line].join("\n"))).toBeUndefined()
    })

    it("refuses `... (truncated` wherever it appears on a line", () => {
      const lines = large.split("\n")
      expect(
        rejection([...lines.slice(0, 199), "export const x = 1 // ... (truncated here"].join("\n"))
          ?.rule,
      ).toBe("elided")
    })

    it("does not refuse a placeholder-like line the baseline already had", () => {
      const before = `${large}\n// (unchanged)`
      expect(rejection(before.replace("value0 = 0", "value0 = 1"), before)).toBeUndefined()
    })

    it("refuses a large file that lost more than half its bytes, and passes a small one", () => {
      const lines = large.split("\n")
      expect(rejection(lines.slice(0, 80).join("\n"))?.rule).toBe("shrunk")
      expect(rejection(lines.slice(0, 120).join("\n"))).toBeUndefined()
      expect(elisionIn("a".repeat(100), "b")).toBeUndefined()
    })
  })
})
