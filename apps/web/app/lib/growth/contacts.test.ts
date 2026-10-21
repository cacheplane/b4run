import { describe, expect, it } from "vitest"
import {
  approvedEventKey,
  deletedEventKey,
  findContactByEmail,
  formAcceptedEventKey,
  isStopReason,
  reapprovedEventKey,
  STOP_REASONS,
  stopEventKey,
} from "./contacts"
import { recordingExecutor } from "./fake-executor"

const NOW = new Date("2026-10-21T12:00:00.000Z")

describe("activity event keys", () => {
  it("builds distinct, deterministic keys", () => {
    expect(formAcceptedEventKey("sub-1")).toBe("form:sub-1")
    expect(approvedEventKey("c1", NOW)).toBe("approved:c1:2026-10-21T12:00:00.000Z")
    expect(reapprovedEventKey("c1", NOW)).toBe("reapproved:c1:2026-10-21T12:00:00.000Z")
    expect(stopEventKey("c1", "unsubscribe", NOW)).toBe(
      "stop:c1:unsubscribe:2026-10-21T12:00:00.000Z",
    )
    expect(deletedEventKey("c1")).toBe("deleted:c1")
  })

  it("gives a later stop a different key", () => {
    const later = new Date(NOW.getTime() + 1000)
    expect(stopEventKey("c1", "complaint", NOW)).not.toBe(stopEventKey("c1", "complaint", later))
  })
})

describe("isStopReason", () => {
  it("accepts every declared reason and rejects others", () => {
    for (const reason of STOP_REASONS) expect(isStopReason(reason)).toBe(true)
    expect(isStopReason("nope")).toBe(false)
    expect(isStopReason(undefined)).toBe(false)
  })
})

describe("findContactByEmail", () => {
  it("looks up by email_hmac with a parameter, never by the email column", async () => {
    const { executor, calls } = recordingExecutor()
    const found = await findContactByEmail(executor, "secret", " Ada@Example.com ")
    expect(found).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toContain("email_hmac = $1")
    expect(calls[0]?.text).not.toMatch(/where\s+email\s*=/i)
    expect(calls[0]?.params).toHaveLength(1)
    expect(String(calls[0]?.params[0])).toMatch(/^[0-9a-f]{64}$/)
  })

  it("returns undefined without querying for an invalid email", async () => {
    const { executor, calls } = recordingExecutor()
    expect(await findContactByEmail(executor, "secret", "not-an-email")).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})
