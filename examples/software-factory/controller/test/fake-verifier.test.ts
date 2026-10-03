import { describe, expect, it } from "vitest"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { createFakeVerifier } from "./fake-verifier.ts"

const input = {
  workOrderId: "wo-1",
  taskId: "cli-flags",
  candidateDigest: "a".repeat(64),
  changes: { "src/cli.ts": "fixed\n" },
  policyDigest: "b".repeat(64),
  image: loadTask("cli-flags").target.image,
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

  it("records every input it was handed, in full", async () => {
    const verifier = createFakeVerifier({ verdict: "pass" })
    await verifier.verify(input, AbortSignal.timeout(1_000))
    expect(verifier.calls).toEqual([input])
  })

  it("issues a single independent check in independentOnly mode, with no visible verdict folded in", async () => {
    // Intake's oracle proof: the independent suite alone. A visible "fail" that leaked into
    // the receipt verdict would let the fake prove an oracle the real verifier never graded.
    const verifier = createFakeVerifier({ visible: "fail", independent: "pass" })
    const receipt = await verifier.verify(
      { ...input, mode: "independentOnly" },
      AbortSignal.timeout(1_000),
    )
    expect(receipt.checks.map((c) => `${c.id}:${c.verdict}`)).toEqual(["independent:pass"])
    expect(receipt.verdict).toBe("pass")
    expect(receipt.checks[0]?.evidence[0]?.id).toBe("independent/output")
  })

  it("issues two checks when the mode is omitted, as before", async () => {
    const verifier = createFakeVerifier({ visible: "fail", independent: "pass" })
    const receipt = await verifier.verify(input, AbortSignal.timeout(1_000))
    expect(receipt.checks.map((c) => c.id)).toEqual(["visible", "independent"])
    expect(receipt.verdict).toBe("fail")
  })
})
