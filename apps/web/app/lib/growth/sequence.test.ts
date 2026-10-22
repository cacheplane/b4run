import { describe, expect, it } from "vitest"
import { composeSequenceEmail } from "./mailer"
import {
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  SEND_BATCH,
  SEND_PACING_MS,
  safeErrorCode,
  sendIdempotencyKey,
} from "./sequence"

describe("founder sequence engine helpers", () => {
  it("formats the send idempotency key", () => {
    expect(sendIdempotencyKey("contact-1", 1)).toBe("seq:v1:contact-1:step:1")
    expect(sendIdempotencyKey("contact-1", 3)).toBe("seq:v1:contact-1:step:3")
  })

  it("uses the same key the composed email carries", () => {
    const email = composeSequenceEmail({
      step: 2,
      to: "ada@example.com",
      sendId: "send-1",
      contactId: "contact-1",
      unsubscribeUrl: "https://b4.run/api/growth/unsubscribe?token=t",
      founderEmail: "brian@b4.run",
      environment: "test",
    })
    expect(email.idempotencyKey).toBe(sendIdempotencyKey("contact-1", 2))
  })

  it("pins the batch, lease, attempt, and pacing constants", () => {
    expect(SEND_BATCH).toBe(10)
    expect(LEASE_SECONDS).toBe(300)
    expect(MAX_ATTEMPTS).toBe(3)
    expect(SEND_PACING_MS).toBe(600)
  })

  it("keeps only short machine error codes", () => {
    expect(safeErrorCode("http_500")).toBe("http_500")
    expect(safeErrorCode("idempotency_mismatch")).toBe("idempotency_mismatch")
    expect(safeErrorCode("bad ada@example.com")).toBe("unclassified")
    expect(safeErrorCode("")).toBe("unclassified")
    expect(safeErrorCode("x".repeat(65))).toBe("unclassified")
  })
})
