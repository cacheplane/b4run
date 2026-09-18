import { describe, expect, it } from "vitest"
import {
  ApprovalSchema,
  BundleSchema,
  CandidateSchema,
  CommandOutcomeSchema,
  ReceiptSchema,
  WorkOrderRowSchema,
} from "../src/domain/work-order.ts"
import {
  classifyDone,
  InterruptFrameSchema,
  isExportGate,
  parsePrepareReviewOutput,
} from "../src/worker/wire.ts"

const digest = "a".repeat(64)

function validRow() {
  return {
    id: "wo-1",
    revision: 0,
    state: "received",
    taskId: "cli-flags",
    workerRoute: "/fix#agent",
    workerThreadId: null,
    interruptId: null,
    candidateDigest: null,
    candidateVerified: null,
    bundleDigest: null,
    blockedReason: null,
    failureReason: null,
    maxCandidateAttempts: 1,
    maxActiveMs: 1000,
    activeMs: 0,
    activeStartedAt: null,
    awaitingSince: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  }
}

describe("work-order schemas", () => {
  it("accepts a well-formed row and rejects an unknown state or malformed digest", () => {
    const row = validRow()
    expect(WorkOrderRowSchema.parse(row)).toEqual(row)
    expect(() => WorkOrderRowSchema.parse({ ...row, state: "shipped" })).toThrow()
    expect(() => WorkOrderRowSchema.parse({ ...row, candidateDigest: "nope" })).toThrow()
  })

  it("requires a message on outcomes", () => {
    expect(() => CommandOutcomeSchema.parse({ ok: true })).toThrow()
    expect(CommandOutcomeSchema.parse({ ok: false, message: "stale" }).ok).toBe(false)
  })
})

describe("wire schemas", () => {
  it("recognises the exportForReview gate and nothing else", () => {
    const gate = InterruptFrameSchema.parse({
      interruptId: "perm-1",
      type: "permission-request",
      kind: "tool",
      detail: {
        toolName: "exportForReview",
        argsPreview: "{}",
        suggestedPattern: "exportForReview",
      },
    })
    expect(isExportGate(gate)).toBe(true)
    const other = InterruptFrameSchema.parse({
      interruptId: "perm-2",
      type: "permission-request",
      kind: "command",
      detail: { command: "rm", suggestedPattern: "rm" },
    })
    expect(isExportGate(other)).toBe(false)
  })

  it("parses prepareReview output given as an object or a JSON string", () => {
    const output = {
      candidate: { receiptDigest: digest, changes: {} },
      verification: { passed: true },
    }
    expect(parsePrepareReviewOutput(output).candidate.receiptDigest).toBe(digest)
    expect(parsePrepareReviewOutput(JSON.stringify(output)).verification.passed).toBe(true)
    expect(() => parsePrepareReviewOutput({ candidate: {} })).toThrow()
  })

  it("classifies done frames", () => {
    expect(classifyDone({ output: { error: "boom" } })).toEqual({ error: "boom", cancelled: false })
    expect(classifyDone({ output: { cancelled: true } })).toEqual({ error: null, cancelled: true })
    expect(classifyDone({ output: { messages: [] } })).toEqual({ error: null, cancelled: false })
    expect(classifyDone("garbage")).toEqual({ error: null, cancelled: false })
  })
})

describe("rung 1 schemas", () => {
  const digest = "a".repeat(64)

  it("carries the frozen bundle digest on the row", () => {
    const row = validRow()
    expect(WorkOrderRowSchema.parse({ ...row, bundleDigest: digest }).bundleDigest).toBe(digest)
    expect(WorkOrderRowSchema.parse(row).bundleDigest).toBeNull()
    expect(() => WorkOrderRowSchema.parse({ ...row, bundleDigest: "short" })).toThrow()
  })

  it("validates a candidate record", () => {
    const candidate = {
      digest,
      workOrderId: "wo-1",
      baselineDigest: "b".repeat(64),
      changedPaths: ["src/cli.ts"],
      bytes: 12,
      artifactDigest: "c".repeat(64),
      assembledAt: "2026-09-18T00:00:00.000Z",
    }
    expect(CandidateSchema.parse(candidate)).toEqual(candidate)
    expect(() => CandidateSchema.parse({ ...candidate, changedPaths: [] })).toThrow()
  })

  it("validates a receipt, including the third verdict", () => {
    const receipt = {
      id: "rc-1",
      workOrderId: "wo-1",
      candidateDigest: digest,
      verifierIdentity: "docker:sha256:abc",
      policyDigest: "d".repeat(64),
      environmentIdentity: "sha256:abc",
      verdict: "inconclusive" as const,
      checks: [
        { id: "independent", acceptanceIds: ["a"], verdict: "inconclusive" as const, evidence: [] },
      ],
      issuedAt: "2026-09-18T00:00:00.000Z",
    }
    expect(ReceiptSchema.parse(receipt).verdict).toBe("inconclusive")
    expect(() => ReceiptSchema.parse({ ...receipt, verdict: "maybe" })).toThrow()
  })

  it("validates a frozen bundle", () => {
    const bundle = {
      digest,
      workOrderId: "wo-1",
      candidateDigest: "e".repeat(64),
      receiptId: "rc-1",
      payload: { repositoryId: "cli-flags" },
      frozenAt: "2026-09-18T00:00:00.000Z",
    }
    expect(BundleSchema.parse(bundle).payload.repositoryId).toBe("cli-flags")
  })

  it("binds an approval to a bundle digest", () => {
    const approval = {
      id: "ap-1",
      workOrderId: "wo-1",
      bundleDigest: digest,
      candidateDigest: "f".repeat(64),
      decision: "approved" as const,
      decidedBy: "operator",
      decidedAt: "2026-09-18T00:00:00.000Z",
      expiresAt: "2026-09-18T00:15:00.000Z",
    }
    expect(ApprovalSchema.parse(approval).bundleDigest).toBe(digest)
    // The rung 0 interrupt coupling is gone.
    expect("interruptId" in ApprovalSchema.parse(approval)).toBe(false)
  })
})
