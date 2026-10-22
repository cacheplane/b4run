import { describe, expect, it } from "vitest"
import { DISCLOSURE_VERSION } from "./disclosure"
import { parseFounderUpdatesSubmission } from "./forms"

const valid = {
  email: "ada@example.com",
  message: "  hello  ",
  disclosure_version: DISCLOSURE_VERSION,
  submission_id: "7d9f3b0e-2c1a-4f6e-9a55-0b1d2c3e4f50",
  posthog_distinct_id: "abc",
}

describe("parseFounderUpdatesSubmission", () => {
  it("parses a valid body with a trimmed message", () => {
    expect(parseFounderUpdatesSubmission(valid)).toEqual({
      ok: true,
      value: {
        email: "ada@example.com",
        message: "hello",
        posthogDistinctId: "abc",
        disclosureVersion: DISCLOSURE_VERSION,
        submissionId: valid.submission_id,
      },
    })
  })

  it("omits blank optional fields", () => {
    const result = parseFounderUpdatesSubmission({
      ...valid,
      message: "  ",
      posthog_distinct_id: "",
    })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect("message" in result.value).toBe(false)
      expect("posthogDistinctId" in result.value).toBe(false)
    }
  })

  it.each([
    null,
    "x",
    3,
    [],
    {},
    { ...valid, submission_id: "nope" },
    { ...valid, posthog_distinct_id: "x".repeat(129) },
  ])("rejects a malformed body %#", (body) => {
    expect(parseFounderUpdatesSubmission(body)).toEqual({
      ok: false,
      error: "invalid_body",
    })
  })

  it("rejects an invalid email", () => {
    expect(parseFounderUpdatesSubmission({ ...valid, email: "not-an-email" })).toEqual({
      ok: false,
      error: "invalid_email",
    })
  })

  it("rejects a message over 1000 characters", () => {
    expect(parseFounderUpdatesSubmission({ ...valid, message: "x".repeat(1001) })).toEqual({
      ok: false,
      error: "message_too_long",
    })
  })

  it("rejects a stale disclosure version", () => {
    expect(parseFounderUpdatesSubmission({ ...valid, disclosure_version: "old" })).toEqual({
      ok: false,
      error: "stale_disclosure",
    })
  })

  it("flags a filled b4_hp honeypot", () => {
    expect(parseFounderUpdatesSubmission({ ...valid, b4_hp: "http://spam" })).toEqual({
      ok: false,
      error: "honeypot",
    })
  })

  it("accepts a blank b4_hp and rejects a non-string one", () => {
    expect(parseFounderUpdatesSubmission({ ...valid, b4_hp: "  " })).toMatchObject({ ok: true })
    expect(parseFounderUpdatesSubmission({ ...valid, b4_hp: 1 })).toEqual({
      ok: false,
      error: "invalid_body",
    })
  })

  it("ignores a filled website_url as an unknown field, since autofill fills it", () => {
    expect(
      parseFounderUpdatesSubmission({ ...valid, website_url: "https://ada.dev" }),
    ).toMatchObject({ ok: true, value: { email: "ada@example.com" } })
  })
})
