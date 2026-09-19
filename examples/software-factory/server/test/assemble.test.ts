import { describe, expect, it } from "vitest"
import { DigestInputError } from "../src/domain/digest.ts"
import { AssemblyRejectedError, assembleCandidate } from "../src/verification/assemble.ts"

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
})
