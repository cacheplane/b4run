import crypto from "node:crypto"

export type ActionTokenPurpose = "unsubscribe" | "founder_stop"

export const TOKEN_MAX_AGE_SECONDS: Readonly<Record<ActionTokenPurpose, number>> = {
  unsubscribe: 157_680_000,
  founder_stop: 604_800,
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const ORIGIN_ERROR = "GROWTH_PUBLIC_ORIGIN must be a bare https origin"

function sign(secret: string, payload: Buffer): Buffer {
  return crypto.createHmac("sha256", secret).update(payload).digest()
}

export function createActionToken(input: {
  secret: string
  contactId: string
  purpose: ActionTokenPurpose
  issuedAt: Date
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: 1,
      c: input.contactId,
      p: input.purpose,
      i: Math.floor(input.issuedAt.getTime() / 1000),
    }),
  )
  return `${payload.toString("base64url")}.${sign(input.secret, payload).toString("base64url")}`
}

export function verifyActionToken(input: {
  token: string
  secret: string
  purpose: ActionTokenPurpose
  now: Date
}): { ok: true; contactId: string } | { ok: false } {
  const fail = { ok: false } as const
  if (!TOKEN_SHAPE.test(input.token)) return fail
  const parts = input.token.split(".")
  if (parts.length !== 2) return fail
  const [encodedPayload, encodedSignature] = parts as [string, string]
  const payload = Buffer.from(encodedPayload, "base64url")
  const received = Buffer.from(encodedSignature, "base64url")
  const expected = sign(input.secret, payload)
  if (received.length !== expected.length) return fail
  if (!crypto.timingSafeEqual(received, expected)) return fail

  let claims: unknown
  try {
    claims = JSON.parse(payload.toString("utf8"))
  } catch {
    return fail
  }
  if (typeof claims !== "object" || claims === null) return fail
  const { v, k, c, p, i } = claims as Record<string, unknown>
  if (v !== 1 || k !== 1 || p !== input.purpose) return fail
  if (typeof c !== "string" || !UUID_PATTERN.test(c)) return fail
  if (typeof i !== "number" || !Number.isFinite(i)) return fail
  const nowSeconds = Math.floor(input.now.getTime() / 1000)
  if (i + TOKEN_MAX_AGE_SECONDS[input.purpose] < nowSeconds) return fail
  return { ok: true, contactId: c }
}

export function unsubscribeUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin}/api/growth/unsubscribe?token=${token}`
}

export function normalizePublicOrigin(value: string): string {
  if (value.includes("?") || value.includes("#")) throw new Error(ORIGIN_ERROR)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(ORIGIN_ERROR)
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.username !== "" ||
    url.password !== "" ||
    url.host === ""
  ) {
    throw new Error(ORIGIN_ERROR)
  }
  return url.origin
}
