import { describe, expect, it } from "vitest"
import {
  APPROVED_LINKS,
  BOOKING_URL,
  draftViolations,
  SEQUENCE_DRAFTS,
  type SequenceStep,
  sequenceDraft,
} from "./sequence-copy"

const steps: SequenceStep[] = [1, 2, 3]
const check = (body: string, subject = "Hello") => draftViolations({ subject, body })

describe("founder sequence drafts", () => {
  it.each(steps)("step %i passes the checker", (step) => {
    expect(draftViolations(SEQUENCE_DRAFTS[step])).toEqual([])
    expect(sequenceDraft(step)).toEqual(SEQUENCE_DRAFTS[step])
  })

  it("keeps step 1 link free and ending with a reply request", () => {
    expect(SEQUENCE_DRAFTS[1].body).not.toMatch(/https?:\/\//)
    expect(SEQUENCE_DRAFTS[1].body.endsWith("Reply if that would help.")).toBe(true)
  })

  it.each([2, 3] as const)("step %i carries exactly the booking link on its own line", (step) => {
    const body = SEQUENCE_DRAFTS[step].body
    expect(body.match(/https?:\/\/\S+/g)).toEqual([BOOKING_URL])
    expect(body.split("\n")).toContain(BOOKING_URL)
  })

  it("ends step 3 with the last-follow-up line", () => {
    expect(SEQUENCE_DRAFTS[3].body.split("\n").at(-1)).toBe("This is my last automated follow-up.")
  })

  it("approves the booking and getting started links", () => {
    expect([...APPROVED_LINKS]).toEqual([
      "https://b4.run/call",
      "https://b4.run/docs/getting-started",
    ])
  })

  it("throws for a mutated draft", () => {
    const original = SEQUENCE_DRAFTS[2]
    const mutated = {
      ...original,
      body: `${original.body}\nhttps://example.com/x`,
    }
    ;(SEQUENCE_DRAFTS as Record<number, unknown>)[2] = mutated
    try {
      expect(() => sequenceDraft(2)).toThrow(/Invalid sequence draft: .*unapproved link/)
    } finally {
      ;(SEQUENCE_DRAFTS as Record<number, unknown>)[2] = original
    }
  })
})

describe("draftViolations", () => {
  it("rejects non-objects and unknown fields", () => {
    expect(draftViolations(null)).toEqual(["draft must be an object"])
    expect(draftViolations({ subject: "a", body: "b", extra: 1 })).toContain(
      "draft contains unknown fields",
    )
  })

  it("rejects bad subjects", () => {
    expect(check("ok", "x".repeat(81))).toContain("subject exceeds 80 characters")
    expect(check("ok", "a\nb")).toContain("subject contains a newline")
    expect(check("ok", "See https://b4.run/call")).toContain("subject contains a URL")
  })

  it("rejects a body over 120 words", () => {
    expect(check("word ".repeat(121))).toContain("body exceeds 120 words")
  })

  it.each([
    ["two questions", "Would this help? What is blocking you?"],
    ["two links", "Read https://b4.run/call and https://b4.run/docs/getting-started"],
    ["an unapproved link", "See https://example.com/guide"],
    ["HTML", "<p>Hello</p>"],
    ["a markdown link", "Read [the docs](/docs)"],
    ["header injection", "Hello\nBcc: victim@example.com"],
    ["an email address", "Writing to ada@example.com."],
    ["a calendar host", "Book at https://calendly.com/b4/demo"],
    ["utm_source", "See https://b4.run/call?utm_source=email"],
    ["a relative link", "See /docs"],
    ["an ftp scheme", "See ftp://evil.example/file"],
    ["I noticed you", "I noticed you reading the docs."],
    ["surveillance wording", "We are tracking your visits."],
  ])("rejects %s", (_name, body) => {
    expect(check(body)).not.toEqual([])
  })

  it("names the matching rule", () => {
    expect(check("We are tracking your visits.")).toContain(
      "message contains surveillance language",
    )
    expect(check("See ftp://evil.example/file")).toContain(
      "message contains an unsupported URL scheme",
    )
    expect(check("See /docs")).toContain("message contains a relative link")
  })

  it("does not treat ordinary prose containing a colon as a URL scheme", () => {
    expect(check("One detail: this is ordinary prose.")).toEqual([])
  })
})
