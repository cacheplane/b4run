/**
 * Everything the delivery path journals, returns or keeps in `last_error` passes through
 * here (rung 4 spec §8.3): the journal is persistent and `factory events` prints it, so it
 * is where a leaked credential would last. Removes the secrets the caller names (the current
 * installation token), any GitHub token shape, any PEM block, any `Authorization` header and
 * any JWT, whatever else the text says.
 */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
const PEM = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g
const AUTHORIZATION = /\b(authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+(?:\s+[^\s"',}]+)?/gi
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of [...secrets]
    .filter((s) => s.length >= 8)
    .sort((a, b) => b.length - a.length))
    out = out.split(secret).join("[REDACTED]")
  return out
    .replace(PEM, "[REDACTED PEM]")
    .replace(GITHUB_TOKEN, "[REDACTED TOKEN]")
    .replace(JWT, "[REDACTED JWT]")
    .replace(AUTHORIZATION, "$1$2[REDACTED]")
}
