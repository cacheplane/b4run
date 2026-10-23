import { describe, expect, it } from "vitest"
import { type DigestData, renderDigestText } from "./digest"

const ADA = "7d9f3b0e-2c1a-4f6e-9a55-0b1d2c3e4f50"
const GRACE = "0b1d2c3e-4f50-4f6e-9a55-7d9f3b0e2c1a"
const stopUrlFor = (contactId: string) =>
  `https://b4.run/api/growth/founder-stop?token=t-${contactId}`

describe("renderDigestText", () => {
  it("lists counts, each new contact, and each in-flight contact with step, Pacific due time and stop URL", () => {
    const data: DigestData = {
      date: "2026-10-22",
      newContacts: [
        { email: "ada@example.com", approvedAt: new Date("2026-10-21T10:00:00.000Z") },
        { email: "linus@example.com", approvedAt: new Date("2026-10-21T22:30:00.000Z") },
      ],
      inFlight: [
        {
          contactId: ADA,
          email: "ada@example.com",
          nextStep: 1,
          dueAt: new Date("2026-10-22T14:00:00.000Z"),
        },
        {
          contactId: GRACE,
          email: "grace@example.com",
          nextStep: 3,
          dueAt: new Date("2026-11-03T15:00:00.000Z"),
        },
      ],
    }
    const text = renderDigestText(data, stopUrlFor)
    expect(text).toContain("B4.run founder digest 2026-10-22")
    expect(text).toContain("New contacts since the last digest: 2")
    expect(text).toContain("- ada@example.com, approved Wed 2026-10-21 03:00 PDT")
    expect(text).toContain("- linus@example.com, approved Wed 2026-10-21 15:30 PDT")
    expect(text).toContain("Sequences in flight: 2")
    expect(text).toContain("- ada@example.com: step 1 due Thu 2026-10-22 07:00 PDT")
    expect(text).toContain(`  Stop: ${stopUrlFor(ADA)}`)
    expect(text).toContain("- grace@example.com: step 3 due Tue 2026-11-03 07:00 PST")
    expect(text).toContain(`  Stop: ${stopUrlFor(GRACE)}`)
    expect(text).not.toContain("<")
  })

  it("says none for empty sections", () => {
    const text = renderDigestText({ date: "2026-10-22", newContacts: [], inFlight: [] }, stopUrlFor)
    expect(text).toContain("New contacts since the last digest: 0\nnone")
    expect(text).toContain("Sequences in flight: 0\nnone")
  })

  it("adds a counts-only line when reply processing holds sends, and none otherwise", () => {
    const held = renderDigestText(
      {
        date: "2026-10-22",
        newContacts: [],
        inFlight: [],
        held: { pendingReplies: 2, unboundSends: 1 },
      },
      stopUrlFor,
    )
    expect(held).toContain(
      "Held for reply processing: 2 pending reply receipts, 1 submitted sends without a Message-ID. See growth:report sends.",
    )
    expect(
      renderDigestText({ date: "2026-10-22", newContacts: [], inFlight: [] }, stopUrlFor),
    ).not.toContain("Held for reply processing")
  })

  it("renders identically on every call for the same data", () => {
    const data: DigestData = {
      date: "2026-10-22",
      newContacts: [],
      inFlight: [
        {
          contactId: ADA,
          email: "ada@example.com",
          nextStep: 2,
          dueAt: new Date("2026-10-27T14:00:00.000Z"),
        },
      ],
    }
    expect(renderDigestText(data, stopUrlFor)).toBe(renderDigestText(data, stopUrlFor))
  })
})
