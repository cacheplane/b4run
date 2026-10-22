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

  it("freezes the shipped copy", () => {
    expect(Object.isFrozen(SEQUENCE_DRAFTS)).toBe(true)
    for (const step of steps) expect(Object.isFrozen(SEQUENCE_DRAFTS[step])).toBe(true)
  })

  it("throws for a mutated draft", () => {
    const mutated = {
      ...SEQUENCE_DRAFTS,
      2: { ...SEQUENCE_DRAFTS[2], body: `${SEQUENCE_DRAFTS[2].body}\nhttps://example.com/x` },
    }
    expect(() => sequenceDraft(2, mutated)).toThrow(
      /^Invalid sequence draft: .*message contains an unapproved link/,
    )
  })
})

describe("draftViolations", () => {
  it("rejects a non-object", () => {
    expect(draftViolations(null)).toEqual(["draft must be an object"])
  })

  it("rejects an unknown field", () => {
    expect(draftViolations({ subject: "a", body: "b", extra: 1 })).toContain(
      "draft contains unknown fields",
    )
  })

  it("rejects a non-string subject or body", () => {
    expect(draftViolations({ subject: 1, body: "b" })).toContain("subject must be a string")
    expect(draftViolations({ subject: "a", body: 2 })).toContain("body must be a string")
  })

  it("rejects an empty subject and an empty body", () => {
    expect(check("ok", "   ")).toContain("subject is empty")
    expect(check("   ")).toContain("body is empty")
  })

  it("rejects subject problems", () => {
    expect(check("ok", "x".repeat(81))).toContain("subject exceeds 80 characters")
    expect(check("ok", "a\nb")).toContain("subject contains a newline")
    expect(check("ok", "See https://b4.run/call")).toContain("subject contains a URL")
  })

  it("rejects a body over 120 words", () => {
    expect(check("word ".repeat(121))).toContain("body exceeds 120 words")
  })

  it("rejects a body over 1200 characters with few words", () => {
    const violations = check("a".repeat(1201))
    expect(violations).toContain("body exceeds 1200 characters")
    expect(violations).not.toContain("body exceeds 120 words")
  })

  it.each([
    [
      "two questions",
      "Would this help? What is blocking you?",
      "body contains more than one question",
    ],
    [
      "two links",
      "Read https://b4.run/call and https://b4.run/docs/getting-started",
      "message contains more than one link",
    ],
    ["an unapproved link", "See https://example.com/guide", "message contains an unapproved link"],
    ["HTML", "<p>Hello</p>", "message contains HTML"],
    ["a markdown image", "![logo](https://b4.run/call)", "message contains markdown image markup"],
    [
      "a markdown link",
      "Read [the docs](https://b4.run/call)",
      "message contains markdown link markup",
    ],
    ["header injection", "Hello\nBcc: hidden", "message contains an injected mail header"],
    ["an email address", "Writing to ada@example.com.", "message contains an email"],
    ["a calendar host", "Book at https://calendly.com/b4/demo", "message contains a calendar link"],
    [
      "utm_source",
      "See https://b4.run/call?utm_source=email",
      "message contains a pixel, beacon, or click-wrapper link",
    ],
    [
      "pixel wording",
      "Open the pixel here.",
      "message contains a pixel, beacon, or click-wrapper link",
    ],
    [
      "beacon wording",
      "A beacon fires on open.",
      "message contains a pixel, beacon, or click-wrapper link",
    ],
    ["a protocol-relative link", "See //b4.run/call", "message contains a protocol-relative link"],
    ["a dot-relative link", "See ./x", "message contains a dot-relative link"],
    ["a parent-relative link", "See ../x", "message contains a dot-relative link"],
    ["a relative link", "See /docs", "message contains a relative link"],
    ["an ftp scheme", "See ftp://evil.example/file", "message contains an unsupported URL scheme"],
    ["I noticed you", "I noticed you reading the docs.", "message contains surveillance language"],
    [
      "surveillance wording",
      "We are tracking your visits.",
      "message contains surveillance language",
    ],
  ])("rejects %s", (_name, body, message) => {
    expect(check(body)).toContain(message)
  })

  it("does not treat ordinary prose containing a colon as a URL scheme", () => {
    expect(check("One detail: this is ordinary prose.")).toEqual([])
  })
})
