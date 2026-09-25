import type {
  ThreadWorkspaceInspectFailure,
  ThreadWorkspaceInspectOutcome,
  ThreadWorkspaceInspectRequest,
} from "../runtime/workspace-protocol.js"
import { createRequestErrorBody } from "./server-errors.js"

/** The inspect request body's own ceiling: it names options, never content. */
export const INSPECT_BODY_MAX_BYTES = 64 * 1024
/** Server caps (D8). A request over one is refused, never silently lowered. */
export const INSPECT_CAPS = Object.freeze({
  maxEntries: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
})
/**
 * The serialized answer's ceiling. The read limits bound file bytes (32 MiB at most),
 * but JSON escapes a control character to six bytes, so an answer within them could
 * reach 192 MiB; one over this is refused (`422 workspace_response_too_large`).
 * `readThreadWorkspace` accepts exactly this much by default.
 */
export const INSPECT_RESPONSE_MAX_BYTES = 64 * 1024 * 1024
/** Defaults: `inspectWorkspace`'s own. */
export const INSPECT_DEFAULTS = Object.freeze({
  maxEntries: 10_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
})
const KEYS = new Set([
  "root",
  "excludeRootDirectories",
  "expectedRootSymlinks",
  "ignorePrefixes",
  "maxEntries",
  "maxFileBytes",
  "maxTotalBytes",
])
const MAX_NAMES = 64

/**
 * `isCanonicalWorkspaceRoot` from `@b4run/workspace`, restated so this module stays in the
 * runtime core's pure graph without pulling that package's barrel in; the endpoint test
 * pins the two to the same answers over a table of roots.
 */
export function isCanonicalRoot(root: string): boolean {
  return (
    root.length > 0 &&
    root.length <= 1024 &&
    root
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          !segment.includes("\\") &&
          ![...segment].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
      )
  )
}

type Parsed =
  | { readonly ok: true; readonly request: ThreadWorkspaceInspectRequest }
  | { readonly ok: false; readonly message: string }

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strings(value: unknown, what: string): string[] | string {
  if (!Array.isArray(value) || value.length > MAX_NAMES)
    return `${what} must be an array of at most ${MAX_NAMES} strings`
  for (const item of value)
    if (typeof item !== "string" || item === "" || item.length > 1024)
      return `${what} must hold non-empty strings of at most 1024 characters`
  return [...value] as string[]
}

function bounded(value: unknown, what: keyof typeof INSPECT_CAPS): number | string {
  if (value === undefined) return INSPECT_DEFAULTS[what]
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > INSPECT_CAPS[what]
  )
    return `${what} must be an integer from 0 to ${INSPECT_CAPS[what]}`
  return value as number
}

/**
 * The body, strictly: own keys only, each known and typed. `root` is checked
 * again (segment by segment) by `inspectWorkspace`, which refuses `..` by name.
 */
export function parseThreadWorkspaceRequest(value: unknown): Parsed {
  if (!isPlain(value)) return { ok: false, message: "The request body must be a JSON object" }
  for (const key of Object.keys(value))
    if (!KEYS.has(key)) return { ok: false, message: `Unknown workspace read option: ${key}` }
  const own = (key: string) => (Object.hasOwn(value, key) ? value[key] : undefined)
  const root = own("root")
  if (root !== undefined && (typeof root !== "string" || !isCanonicalRoot(root)))
    return {
      ok: false,
      message: `Invalid workspace inspection root: ${JSON.stringify(root)} (relative leaf names, no "..", ".", empty segment, backslash or control character)`,
    }
  const excluded =
    own("excludeRootDirectories") === undefined
      ? []
      : strings(own("excludeRootDirectories"), "excludeRootDirectories")
  if (typeof excluded === "string") return { ok: false, message: excluded }
  const ignored =
    own("ignorePrefixes") === undefined ? [] : strings(own("ignorePrefixes"), "ignorePrefixes")
  if (typeof ignored === "string") return { ok: false, message: ignored }
  if (ignored.some((prefix) => prefix.startsWith("/")))
    return { ok: false, message: "ignorePrefixes are relative to the inspected root" }
  const links = own("expectedRootSymlinks")
  const expectedRootSymlinks: Record<string, string> = Object.create(null)
  if (links !== undefined) {
    if (!isPlain(links) || Object.keys(links).length > MAX_NAMES)
      return {
        ok: false,
        message: `expectedRootSymlinks must be an object of at most ${MAX_NAMES} names`,
      }
    for (const [name, target] of Object.entries(links)) {
      if (typeof target !== "string" || target === "" || target.length > 4096)
        return { ok: false, message: `expectedRootSymlinks.${name} must be a non-empty string` }
      Object.defineProperty(expectedRootSymlinks, name, { value: target, enumerable: true })
    }
  }
  const maxEntries = bounded(own("maxEntries"), "maxEntries")
  const maxFileBytes = bounded(own("maxFileBytes"), "maxFileBytes")
  const maxTotalBytes = bounded(own("maxTotalBytes"), "maxTotalBytes")
  for (const limit of [maxEntries, maxFileBytes, maxTotalBytes])
    if (typeof limit === "string") return { ok: false, message: limit }
  return {
    ok: true,
    request: {
      ...(root !== undefined ? { root: root as string } : {}),
      excludeRootDirectories: excluded,
      expectedRootSymlinks,
      ignorePrefixes: ignored,
      maxEntries: maxEntries as number,
      maxFileBytes: maxFileBytes as number,
      maxTotalBytes: maxTotalBytes as number,
    },
  }
}

const STATUS: Readonly<Record<ThreadWorkspaceInspectFailure, number>> = {
  workspace_not_found: 404,
  workspace_lost: 404,
  workspace_expired: 410,
  workspace_not_ready: 409,
  workspace_conflict: 409,
  workspace_changed: 409,
  workspace_unavailable: 503,
  workspace_root_missing: 422,
  workspace_inspection_refused: 422,
  workspace_read_timeout: 504,
  invalid_request: 400,
}

/**
 * The one place an outcome becomes bytes. `ignorePrefixes` are applied here, to keys
 * relative to the root: the files are dropped from `files`, but they were read, so they
 * still count in `totalBytes` and `entries` (and against the byte and entry limits).
 * The two counts describe the inspection, not the answer.
 */
export function threadWorkspaceResponse(
  threadId: string,
  request: ThreadWorkspaceInspectRequest,
  outcome: ThreadWorkspaceInspectOutcome,
): Response {
  if (!outcome.ok)
    return Response.json(
      createRequestErrorBody(outcome.message, {
        code: outcome.code,
        ...(outcome.root !== undefined ? { root: outcome.root } : {}),
        ...(outcome.kind !== undefined ? { kind: outcome.kind } : {}),
      }),
      { status: STATUS[outcome.code] },
    )
  const files: Record<string, string> = Object.create(null)
  for (const [path, text] of Object.entries(outcome.inspection.files))
    if (!request.ignorePrefixes.some((prefix) => path.startsWith(prefix)))
      Object.defineProperty(files, path, { value: text, enumerable: true })
  const serialized = JSON.stringify({
    threadId,
    sourceDigest: outcome.sourceDigest,
    intentDigest: outcome.intentDigest,
    ...(request.root !== undefined ? { root: request.root } : {}),
    inspection: {
      files,
      symlinks: outcome.inspection.symlinks,
      totalBytes: outcome.inspection.totalBytes,
      entries: outcome.inspection.entries,
    },
  })
  // The read limits count file bytes; the answer is JSON, where a control character
  // escapes to six bytes. Measured before encoding, so an over-cap answer is never built.
  if (utf8Length(serialized) > INSPECT_RESPONSE_MAX_BYTES)
    return Response.json(
      createRequestErrorBody(
        `The workspace inventory serializes to more than ${INSPECT_RESPONSE_MAX_BYTES} bytes; read a narrower root or lower the limits`,
        { code: "workspace_response_too_large", maxBytes: INSPECT_RESPONSE_MAX_BYTES },
      ),
      { status: 422 },
    )
  return new Response(serialized, {
    status: 200,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  })
}

/** The UTF-8 length of a string, without encoding it. */
function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}
