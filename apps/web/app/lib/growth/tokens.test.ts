import crypto from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createActionToken,
  founderStopUrl,
  normalizePublicOrigin,
  TOKEN_MAX_AGE_SECONDS,
  unsubscribeUrl,
  verifyActionToken,
} from "./tokens"

const secret = "test-secret"
const keyring = { active: { id: 1, secret }, previous: [] }
const contactId = "6f1c1c58-52a8-4b3a-9c1f-5a4d2f3d1e11"
const issuedAt = new Date("2026-01-01T00:00:00Z")

function make(purpose: "unsubscribe" | "founder_stop" = "unsubscribe") {
  return createActionToken({ keyring, contactId, purpose, issuedAt })
}

afterEach(() => vi.restoreAllMocks())

describe("action tokens", () => {
  it("round-trips a token for the same purpose and secret", () => {
    expect(
      verifyActionToken({
        token: make(),
        keyring,
        purpose: "unsubscribe",
        now: issuedAt,
      }),
    ).toEqual({ ok: true, contactId })
  })

  it("expires by purpose at the exact boundary", () => {
    const edge = new Date(issuedAt.getTime() + TOKEN_MAX_AGE_SECONDS.founder_stop * 1000)
    const late = new Date(edge.getTime() + 1000)
    const token = make("founder_stop")
    expect(verifyActionToken({ token, keyring, purpose: "founder_stop", now: edge }).ok).toBe(true)
    expect(verifyActionToken({ token, keyring, purpose: "founder_stop", now: late })).toEqual({
      ok: false,
    })
  })

  const forge = (payload: unknown) => {
    const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))
    const sig = crypto.createHmac("sha256", secret).update(body).digest()
    return `${body.toString("base64url")}.${sig.toString("base64url")}`
  }

  const cases: Array<
    [
      string,
      () => {
        token: string
        purpose?: "unsubscribe" | "founder_stop"
        now?: Date
      },
    ]
  > = [
    ["wrong purpose", () => ({ token: make("founder_stop") })],
    [
      "tampered signature",
      () => {
        const [body, sig] = make().split(".") as [string, string]
        const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1)
        return { token: `${body}.${flipped}` }
      },
    ],
    [
      "expired by one second",
      () => ({
        token: make(),
        now: new Date(issuedAt.getTime() + (TOKEN_MAX_AGE_SECONDS.unsubscribe + 1) * 1000),
      }),
    ],
    ["malformed (no dot)", () => ({ token: "abcdef" })],
    [
      "unknown key id",
      () => ({
        token: forge({ v: 1, k: 2, c: contactId, p: "unsubscribe", i: 1767225600 }),
      }),
    ],
    [
      "missing key id",
      () => ({
        token: forge({ v: 1, c: contactId, p: "unsubscribe", i: 1767225600 }),
      }),
    ],
    [
      "characters outside the base64url alphabet",
      () => {
        const [body, sig] = make().split(".") as [string, string]
        return { token: `${body}<.${sig}` }
      },
    ],
    ["payload not JSON", () => ({ token: forge("not json") })],
    [
      "non-uuid contact",
      () => ({
        token: forge({ v: 1, k: 1, c: "x", p: "unsubscribe", i: 1767225600 }),
      }),
    ],
    [
      "wrong version",
      () => ({
        token: forge({ v: 2, k: 1, c: contactId, p: "unsubscribe", i: 1767225600 }),
      }),
    ],
  ]
  it.each(cases)("rejects %s uniformly", (_name, build) => {
    const { token, purpose, now } = build()
    expect(
      verifyActionToken({
        token,
        keyring,
        purpose: purpose ?? "unsubscribe",
        now: now ?? issuedAt,
      }),
    ).toEqual({ ok: false })
  })

  describe("key rotation", () => {
    const key2 = { id: 2, secret: "rotated-secret" }
    const rotated = { active: key2, previous: [{ id: 1, secret }] }
    const dropped = { active: key2, previous: [] }

    it("verifies a key-1 token after rotating to key 2 with key 1 as previous", () => {
      expect(
        verifyActionToken({
          token: make(),
          keyring: rotated,
          purpose: "unsubscribe",
          now: issuedAt,
        }),
      ).toEqual({ ok: true, contactId })
    })

    it("mints new tokens under the active key id", () => {
      const token = createActionToken({
        keyring: rotated,
        contactId,
        purpose: "unsubscribe",
        issuedAt,
      })
      const claims = JSON.parse(Buffer.from(token.split(".")[0] as string, "base64url").toString())
      expect(claims.k).toBe(2)
      expect(
        verifyActionToken({ token, keyring: rotated, purpose: "unsubscribe", now: issuedAt }).ok,
      ).toBe(true)
      expect(verifyActionToken({ token, keyring, purpose: "unsubscribe", now: issuedAt })).toEqual({
        ok: false,
      })
    })

    it("fails once key 1 is dropped", () => {
      expect(
        verifyActionToken({
          token: make(),
          keyring: dropped,
          purpose: "unsubscribe",
          now: issuedAt,
        }),
      ).toEqual({ ok: false })
    })

    it("rejects a token whose k names a key with a different secret", () => {
      const body = Buffer.from(
        JSON.stringify({ v: 1, k: 2, c: contactId, p: "unsubscribe", i: 1767225600 }),
      )
      const sig = crypto.createHmac("sha256", secret).update(body).digest()
      const token = `${body.toString("base64url")}.${sig.toString("base64url")}`
      expect(
        verifyActionToken({ token, keyring: rotated, purpose: "unsubscribe", now: issuedAt }),
      ).toEqual({ ok: false })
    })

    it.each([0, -1, 1.5, "1", null])("rejects a non-positive-integer k (%s)", (k) => {
      const body = Buffer.from(
        JSON.stringify({ v: 1, k, c: contactId, p: "unsubscribe", i: 1767225600 }),
      )
      const sig = crypto.createHmac("sha256", secret).update(body).digest()
      const token = `${body.toString("base64url")}.${sig.toString("base64url")}`
      expect(verifyActionToken({ token, keyring, purpose: "unsubscribe", now: issuedAt })).toEqual({
        ok: false,
      })
    })
  })

  it("rejects a different secret", () => {
    expect(
      verifyActionToken({
        token: make(),
        keyring: { active: { id: 1, secret: "other" }, previous: [] },
        purpose: "unsubscribe",
        now: issuedAt,
      }),
    ).toEqual({ ok: false })
  })

  it("uses constant-time comparison", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual")
    const [body, sig] = make().split(".") as [string, string]
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1)
    verifyActionToken({
      token: `${body}.${flipped}`,
      keyring,
      purpose: "unsubscribe",
      now: issuedAt,
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe("normalizePublicOrigin", () => {
  it.each([
    "http://b4.run",
    "https://b4.run/x",
    "https://b4.run?x",
    "https://b4.run/#a",
    "https://u:p@b4.run",
    "b4.run",
    "",
  ])("rejects %s", (value) => {
    expect(() => normalizePublicOrigin(value)).toThrow(
      "GROWTH_PUBLIC_ORIGIN must be a bare https origin",
    )
  })

  it.each([
    ["https://b4.run", "https://b4.run"],
    ["https://b4.run/", "https://b4.run"],
    ["https://b4.run:8443", "https://b4.run:8443"],
  ])("accepts %s", (value, expected) => {
    expect(normalizePublicOrigin(value)).toBe(expected)
  })

  it("builds the unsubscribe url", () => {
    expect(unsubscribeUrl("https://b4.run", "t.k")).toBe(
      "https://b4.run/api/growth/unsubscribe?token=t.k",
    )
  })

  it("builds the founder-stop url", () => {
    expect(founderStopUrl("https://b4.run", "abc.def")).toBe(
      "https://b4.run/api/growth/founder-stop?token=abc.def",
    )
  })
})
