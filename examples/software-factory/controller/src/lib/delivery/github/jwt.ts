import { createPrivateKey, createSign, type KeyObject } from "node:crypto"
import { readFileSync, statSync } from "node:fs"

/**
 * The GitHub App's own credential (rung 4 spec §6.1, §8): an RS256 JWT signed with the app's
 * private key, used only to find the installation and mint an installation token. Signed
 * with `node:crypto`; no dependency.
 */

/** Read the app's private key: a regular file, private to its owner, never echoed. */
export function loadAppPrivateKey(path: string): KeyObject {
  let mode: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error("not a regular file")
    mode = stat.mode
  } catch (error) {
    throw new Error(`the GitHub App key ${path} cannot be used: ${(error as Error).message}`)
  }
  if ((mode & 0o077) !== 0)
    throw new Error(
      `the GitHub App key ${path} is readable by group or other (mode ${(mode & 0o777).toString(8)}): chmod 600 it`,
    )
  try {
    return createPrivateKey(readFileSync(path))
  } catch {
    // Never the parser's message: it can quote the file.
    throw new Error(`the GitHub App key ${path} is not a PEM private key`)
  }
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

/** A JWT GitHub accepts: issued a minute in the past (clock skew), expiring nine minutes on. */
export function appJwt(appId: number, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000)
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat: now - 60, exp: now + 540, iss: appId })}`
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")
  return `${unsigned}.${signature}`
}
