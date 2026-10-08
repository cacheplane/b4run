/**
 * The node-only half of auth loading: the disk probe and the dynamic import.
 * Same pure/node split, and the same fail-closed rules, as
 * `thread-access-node.ts`: existence is decided before the import, so an
 * import failure can only mean "the auth file is broken", and an auth file
 * that binds nothing fails the boot instead of leaving every request
 * anonymous.
 */

import { lstatSync } from "node:fs"
import { pathToFileURL } from "node:url"
import type { AuthDefinition } from "@b4run/sdk"

import { diagnose } from "../diagnostics.js"
import { CliError } from "../output.js"
import { authCandidatePaths, authExportError } from "./auth.js"

/** The syscall the existence probe is built on. A seam so tests can force an errno. */
type StatPath = (path: string) => void

export interface LoadAuthOptions {
  /** Override the `lstat` the probe uses. Test seam only. */
  readonly statPath?: StatPath
  /** Override the dynamic import. Test seam only. */
  readonly importModule?: (href: string) => Promise<unknown>
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined
}

/** Whether an entry exists; only ENOENT and ENOTDIR mean absent (see `thread-access-node.ts`). */
function candidateExists(path: string, statPath: StatPath): boolean {
  try {
    statPath(path)
    return true
  } catch (error) {
    const errno = errnoOf(error)
    if (errno === "ENOENT" || errno === "ENOTDIR") return false
    throw new CliError(
      `Auth file at ${path} could not be probed (${errno ?? "unknown error"}), so B4.run cannot tell ` +
        "whether this app authenticates requests and will not boot without it. " +
        `Fix the path's permissions, or delete it if this app has no auth.\n\n${String(error)}`,
      1,
      { cause: error, code: "B4_E3005" },
    )
  }
}

/** The first auth candidate that exists, or undefined when every one is definitively absent. */
export function findAuthFile(appRoot: string, statPath: StatPath = lstatSync): string | undefined {
  return authCandidatePaths(appRoot).find((candidate) => candidateExists(candidate, statPath))
}

/**
 * Load the app's `src/auth.ts`.
 *
 *   • every candidate definitively absent       -> undefined (every request anonymous)
 *   • a candidate cannot be probed               -> THROW (B4_E3005)
 *   • the first existing candidate won't import  -> THROW (B4_E3005)
 *   • its default export is missing or not `defineAuth(...)` -> THROW (B4_E3005)
 */
export async function loadAuth(
  appRoot: string,
  options?: LoadAuthOptions,
): Promise<AuthDefinition | undefined> {
  const path = findAuthFile(appRoot, options?.statPath ?? lstatSync)
  if (!path) return undefined

  let mod: unknown
  try {
    const href = pathToFileURL(path).href
    mod = options?.importModule ? await options.importModule(href) : await import(href)
  } catch (error) {
    const diag = diagnose(error, { appRoot })
    const detail = diag ? `${diag.summary}\n\n${diag.hint}` : String(error)
    throw new CliError(
      `Auth file at ${path} failed to import, so no request could be authenticated. ` +
        `Fix the file, or delete it if this app has no auth.\n\n${detail}`,
      1,
      { cause: error, code: "B4_E3005" },
    )
  }

  const reason = authExportError(mod)
  if (reason) {
    throw new CliError(`Auth file at ${path} binds no auth: ${reason}.`, 1, { code: "B4_E3005" })
  }
  return (mod as { readonly default: AuthDefinition }).default
}
