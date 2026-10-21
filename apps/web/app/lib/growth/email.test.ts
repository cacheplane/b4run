import { describe, expect, it } from "vitest"

import { emailKind, emailLookupHmac, normalizeEmail, PERSONAL_DOMAINS } from "./email"

describe("normalizeEmail", () => {
  it.each([
    ["  Brian@B4.RUN ", "brian@b4.run"],
    ["x@y", undefined],
    ["", undefined],
    ["a b@c.de", undefined],
    ["a@@c.de", undefined],
  ])("normalizeEmail(%j)", (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected)
  })

  it("rejects an address longer than 320 characters", () => {
    expect(normalizeEmail(`${"a".repeat(316)}@b.co`)).toBeUndefined()
    expect(normalizeEmail(`${"a".repeat(300)}@b.co`)).toBeDefined()
  })
})

describe("emailLookupHmac", () => {
  it("produces the same hmac for equivalent spellings and a different one per secret", () => {
    const a = emailLookupHmac("s1", normalizeEmail("Brian@B4.run") as string)
    const b = emailLookupHmac("s1", normalizeEmail(" brian@b4.RUN") as string)
    const c = emailLookupHmac("s2", "brian@b4.run")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(c).not.toBe(a)
  })
})

describe("emailKind", () => {
  it.each([
    ["a@gmail.com", "personal"],
    ["a@mail.proton.me", "personal"],
    ["a@cacheplane.ai", "work"],
    ["a@notgmail.com", "work"],
  ])("emailKind(%s)", (email, kind) => {
    expect(emailKind(email)).toBe(kind)
  })

  it("lists the personal domains", () => {
    expect(PERSONAL_DOMAINS).toContain("gmail.com")
  })
})
