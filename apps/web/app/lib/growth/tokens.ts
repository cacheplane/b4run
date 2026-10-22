import crypto from "node:crypto"

export type ActionTokenPurpose = "unsubscribe" | "founder_stop"

export interface TokenKey {
  readonly id: number
  readonly secret: string
}

export interface TokenKeyring {
  readonly active: TokenKey
  readonly previous: readonly TokenKey[]
}

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

function readKeyId(payload: Buffer): number | undefined {
  try {
    const claims: unknown = JSON.parse(payload.toString("utf8"))
    if (typeof claims !== "object" || claims === null) return undefined
    const { k } = claims as Record<string, unknown>
    return typeof k === "number" && Number.isSafeInteger(k) && k > 0 ? k : undefined
  } catch {
    return undefined
  }
}

export function createActionToken(input: {
  keyring: TokenKeyring
  contactId: string
  purpose: ActionTokenPurpose
  issuedAt: Date
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: input.keyring.active.id,
      c: input.contactId,
      p: input.purpose,
      i: Math.floor(input.issuedAt.getTime() / 1000),
    }),
  )
  return `${payload.toString("base64url")}.${sign(input.keyring.active.secret, payload).toString("base64url")}`
}

export function verifyActionToken(input: {
  token: string
  keyring: TokenKeyring
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
  const keyId = readKeyId(payload)
  if (keyId === undefined) return fail
  const key = [input.keyring.active, ...input.keyring.previous].find((entry) => entry.id === keyId)
  if (key === undefined) return fail
  const expected = sign(key.secret, payload)
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
  if (v !== 1 || k !== keyId || p !== input.purpose) return fail
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
