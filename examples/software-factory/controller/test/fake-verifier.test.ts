import { describe, expect, it } from "vitest"
import { createFakeVerifier } from "./fake-verifier.ts"

const input = {
  workOrderId: "wo-1",
  taskId: "cli-flags",
  candidateDigest: "a".repeat(64),
  changes: { "src/cli.ts": "fixed\n" },
  policyDigest: "b".repeat(64),
}

describe("fake verifier", () => {
  it("issues a passing receipt whose identity comes from the harness", async () => {
    const verifier = createFakeVerifier({ verdict: "pass" })
    const receipt = await verifier.verify(input, AbortSignal.timeout(1_000))
    expect(receipt.verdict).toBe("pass")
    expect(receipt.verifierIdentity).toMatch(/^fake:/)
    expect(receipt.candidateDigest).toBe(input.candidateDigest)
    expect(receipt.policyDigest).toBe(input.policyDigest)
    expect(receipt.checks.map((c) => c.id)).toEqual(["visible", "independent"])
  })

  it("scripts the visible-passes-independent-fails case, which is rung 1's point", async () => {
    const verifier = createFakeVerifier({ verdict: "fail", visible: "pass", independent: "fail" })
    const receipt = await verifier.verify(input, AbortSignal.timeout(1_000))
    expect(receipt.verdict).toBe("fail")
    expect(receipt.checks.find((c) => c.id === "visible")?.verdict).toBe("pass")
    expect(receipt.checks.find((c) => c.id === "independent")?.verdict).toBe("fail")
  })

  it("scripts an inconclusive run", async () => {
    const verifier = createFakeVerifier({ verdict: "inconclusive" })
    expect((await verifier.verify(input, AbortSignal.timeout(1_000))).verdict).toBe("inconclusive")
  })

  it("can throw, so the controller's error path is reachable", async () => {
    const verifier = createFakeVerifier({ throws: "docker unavailable" })
    await expect(verifier.verify(input, AbortSignal.timeout(1_000))).rejects.toThrow(
      /docker unavailable/,
    )
  })

  it("records every candidate it verified", async () => {
    const verifier = createFakeVerifier({ verdict: "pass" })
    await verifier.verify(input, AbortSignal.timeout(1_000))
    expect(verifier.verified).toEqual([input.candidateDigest])
  })
})
