import { createHmac } from "node:crypto"

export type EmailKind = "work" | "personal"

export const PERSONAL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "fastmail.com",
  "hey.com",
  "yandex.com",
  "zoho.com",
]

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LENGTH = 320

export function normalizeEmail(input: string): string | undefined {
  const value = input.trim().toLowerCase()
  if (value.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value)) return undefined
  return value
}

export function emailLookupHmac(secret: string, normalizedEmail: string): string {
  return createHmac("sha256", secret).update(normalizedEmail).digest("hex")
}

export function emailKind(normalizedEmail: string): EmailKind {
  const domain = normalizedEmail.slice(normalizedEmail.lastIndexOf("@") + 1)
  const personal = PERSONAL_DOMAINS.some(
    (entry) => domain === entry || domain.endsWith(`.${entry}`),
  )
  return personal ? "personal" : "work"
}
