import { describe, expect, it } from "vitest"
import { CommandOutcomeSchema, WorkOrderRowSchema } from "../src/domain/work-order.ts"
import {
  classifyDone,
  InterruptFrameSchema,
  isExportGate,
  parsePrepareReviewOutput,
} from "../src/worker/wire.ts"

const digest = "a".repeat(64)

describe("work-order schemas", () => {
  it("accepts a well-formed row and rejects an unknown state or malformed digest", () => {
    const row = {
      id: "wo-1",
      revision: 0,
      state: "received",
      taskId: "cli-flags",
      workerRoute: "/fix#agent",
      workerThreadId: null,
      interruptId: null,
      candidateDigest: null,
      candidateVerified: null,
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
