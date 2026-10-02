import { createPrivateKey, createSign, type KeyObject } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"

/**
 * The GitHub App's own credential (rung 4 spec §6.1, §8): an RS256 JWT signed with the app's
 * private key, used only to find the installation and mint an installation token. Signed
 * with `node:crypto`; no dependency.
 */

/** The longest key path accepted: a longer one is not a path someone typed. */
export const MAX_KEY_PATH_LENGTH = 1024

/**
 * Whether a value given as the key's path is (or may be) the key itself: a PEM header, a line
 * break, or longer than any path. Such a value is refused by name and never quoted, since every
 * message that names the path would otherwise print the key.
 */
export function notAKeyPath(value: string): boolean {
  return value.includes("-----BEGIN") || /[\r\n]/.test(value) || value.length > MAX_KEY_PATH_LENGTH
}

/**
 * Read the app's private key: a regular file, private to its owner, an RSA key, never echoed.
 * The descriptor opened is the one checked and read, so the file cannot be swapped between.
 */
export function loadAppPrivateKey(path: string): KeyObject {
  if (notAKeyPath(path))
    throw new Error(
      `the GitHub App key's path is not a path (it holds a PEM header or a line break, or is over ${MAX_KEY_PATH_LENGTH} characters): name the key's file, never the key`,
    )
  let fd: number
  try {
    // Non-blocking: a FIFO at the path would otherwise hold the open until something writes,
    // stopping the controller. The fstat below then refuses anything but a regular file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    // The code only: a read error's message repeats the path, and nothing more is needed.
    throw new Error(
      `the GitHub App key ${path} cannot be used (${(error as NodeJS.ErrnoException).code})`,
    )
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile())
      throw new Error(`the GitHub App key ${path} cannot be used: not a regular file`)
    if ((stat.mode & 0o077) !== 0)
      throw new Error(
        `the GitHub App key ${path} is readable by group or other (mode ${(stat.mode & 0o777).toString(8)}): chmod 600 it`,
      )
    let key: KeyObject
    try {
      key = createPrivateKey(readFileSync(fd))
    } catch {
      // Never the parser's message: it can quote the file.
      throw new Error(`the GitHub App key ${path} is not a PEM private key`)
    }
    if (key.asymmetricKeyType !== "rsa")
      throw new Error(`the GitHub App key ${path} is not an RSA private key; GitHub signs RS256`)
    return key
  } finally {
    closeSync(fd)
  }
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

/** A JWT GitHub accepts: issued a minute in the past (clock skew), expiring nine minutes on. */
export function appJwt(appId: number, key: KeyObject, nowMs: number): string {
  if (key.asymmetricKeyType !== "rsa") throw new Error("the GitHub App key is not an RSA key")
  const now = Math.floor(nowMs / 1000)
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat: now - 60, exp: now + 540, iss: appId })}`
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")
  return `${unsigned}.${signature}`
}
