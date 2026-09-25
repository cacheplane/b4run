import type { WorkspaceInspection } from "@b4run/workspace"

/** The options `POST /threads/:thread_id/workspace/inspect` accepts. */
export interface ReadThreadWorkspaceOptions {
  /** Start the inspection here (e.g. `"draft"`); keys come back relative to it. */
  readonly root?: string
  readonly excludeRootDirectories?: readonly string[]
  readonly expectedRootSymlinks?: Readonly<Record<string, string>>
  /** Keys under these prefixes (relative to `root`) are left out of the answer. */
  readonly ignorePrefixes?: readonly string[]
  readonly maxEntries?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}

export interface ReadThreadWorkspaceInit {
  /** Sent with the request: the worker's thread-access policy reads them. */
  readonly headers?: ConstructorParameters<typeof Headers>[0]
  readonly signal?: AbortSignal
  /** Refuse an answer whose recorded source is not this digest (`source_mismatch`). */
  readonly expectedSourceDigest?: string
  /** Refuse an answer larger than this (`response_too_large`). Default 80 MiB: 32 MiB of text, JSON-escaped. */
  readonly maxResponseBytes?: number
  readonly fetch?: typeof fetch
}

export interface ThreadWorkspaceRead {
  readonly threadId: string
  /** The source the thread's workspace was created from, as the worker recorded it. */
  readonly sourceDigest: string
  readonly intentDigest: string
  readonly root?: string
  readonly inspection: WorkspaceInspection
}

/**
 * A read that did not produce a verified inventory. `status` is the HTTP status
 * (0 for a local refusal of the answer); `code` is the worker's
 * (`workspace_root_missing`, `run_in_flight`, `workspace_changed`, ...) or the
 * client's own (`source_mismatch`, `thread_mismatch`, `root_mismatch`, `malformed_response`, `response_too_large`).
 */
export class ThreadWorkspaceReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = "ThreadWorkspaceReadError"
  }
}

const DIGEST = /^[0-9a-f]{64}$/

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function malformed(why: string): ThreadWorkspaceReadError {
  return new ThreadWorkspaceReadError(
    0,
    "malformed_response",
    `Malformed workspace read response: ${why}`,
  )
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const keys = Object.keys(value)
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => ![...required, ...optional].includes(key))
  )
    throw malformed(
      `expected keys ${[...required, ...optional].join(", ")}, got ${keys.join(", ")}`,
    )
}

const RESPONSE_MAX_BYTES = 80 * 1024 * 1024

/** A leaf name as `inspectWorkspace` admits one: no empty, `.`, `..`, slash, backslash or control character. */
function isLeaf(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    ![...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
}

/**
 * Own string values only, copied onto a null prototype so no key can reach
 * `Object.prototype`. Every key must be a relative path of leaf names (`nested`) or a
 * single leaf: a caller that joins a key to a directory can never be walked out of it.
 */
function textRecord(value: unknown, what: string, nested: boolean): Record<string, string> {
  if (!isPlain(value)) throw malformed(`${what} is not an object`)
  const copy: Record<string, string> = Object.create(null)
  for (const [key, text] of Object.entries(value)) {
    if (!(nested ? key.split("/").every(isLeaf) : isLeaf(key)))
      throw malformed(`${what} key ${JSON.stringify(key)} is not a relative path`)
    if (typeof text !== "string") throw malformed(`${what}.${key} is not a string`)
    Object.defineProperty(copy, key, { value: text, enumerable: true })
  }
  return copy
}

/** The body as text, refusing more than `max` bytes before holding it whole. */
async function boundedText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  const parts: string[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new ThreadWorkspaceReadError(
        0,
        "response_too_large",
        `The worker's answer exceeds ${max} bytes`,
      )
    }
    parts.push(decoder.decode(value, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join("")
}

function count(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw malformed(`${what} is not a count`)
  return value as number
}

function verify(
  body: unknown,
  threadId: string,
  requestedRoot: string | undefined,
  init: ReadThreadWorkspaceInit,
): ThreadWorkspaceRead {
  if (!isPlain(body)) throw malformed("not an object")
  exactKeys(body, ["threadId", "sourceDigest", "intentDigest", "inspection"], ["root"])
  if (typeof body.sourceDigest !== "string" || !DIGEST.test(body.sourceDigest))
    throw malformed("sourceDigest")
  if (typeof body.intentDigest !== "string" || !DIGEST.test(body.intentDigest))
    throw malformed("intentDigest")
  if (body.root !== undefined && typeof body.root !== "string") throw malformed("root")
  if (!isPlain(body.inspection)) throw malformed("inspection")
  exactKeys(body.inspection, ["files", "symlinks", "totalBytes", "entries"])
  const read: ThreadWorkspaceRead = {
    threadId: String(body.threadId),
    sourceDigest: body.sourceDigest,
    intentDigest: body.intentDigest,
    ...(typeof body.root === "string" ? { root: body.root } : {}),
    inspection: {
      files: textRecord(body.inspection.files, "files", true),
      symlinks: textRecord(body.inspection.symlinks, "symlinks", false),
      totalBytes: count(body.inspection.totalBytes, "totalBytes"),
      entries: count(body.inspection.entries, "entries"),
    },
  }
  if (body.threadId !== threadId)
    throw new ThreadWorkspaceReadError(
      0,
      "thread_mismatch",
      `The worker answered for thread ${JSON.stringify(body.threadId)}, not ${JSON.stringify(threadId)}`,
    )
  if (init.expectedSourceDigest !== undefined && read.sourceDigest !== init.expectedSourceDigest)
    throw new ThreadWorkspaceReadError(
      0,
      "source_mismatch",
      `Thread ${threadId}'s workspace was created from ${read.sourceDigest}, not the expected ${init.expectedSourceDigest}`,
    )
  // File keys are relative to the answer's root: one about another directory would be
  // joined to the wrong place.
  if (read.root !== requestedRoot)
    throw new ThreadWorkspaceReadError(
      0,
      "root_mismatch",
      `The worker answered for root ${JSON.stringify(read.root)}, not ${JSON.stringify(requestedRoot)}`,
    )
  return read
}

/**
 * Read a thread's workspace from a worker that serves `sandbox.workspaceRead:
 * "http"`, authorized by whatever `init.headers` carry. The worker runs the
 * read in a separate, networkless, read-only container; this only transports
 * and verifies the answer. Nothing it returns is trusted beyond its shape:
 * diff and verify the bytes before acting on them.
 */
export async function readThreadWorkspace(
  baseUrl: string,
  threadId: string,
  options: ReadThreadWorkspaceOptions = {},
  init: ReadThreadWorkspaceInit = {},
): Promise<ThreadWorkspaceRead> {
  const url = `${baseUrl.replace(/\/$/, "")}/threads/${encodeURIComponent(threadId)}/workspace/inspect`
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json")
  const response = await (init.fetch ?? fetch)(url, {
    method: "POST",
    headers,
    body: JSON.stringify(options),
    // A redirect would carry the credential in `headers` to wherever it points.
    redirect: "error",
    ...(init.signal ? { signal: init.signal } : {}),
  })
  const text = await boundedText(response, init.maxResponseBytes ?? RESPONSE_MAX_BYTES)
  if (!response.ok) {
    let message = text
    let code: string | undefined
    let details: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown; details?: unknown } }
      if (typeof parsed.error?.message === "string") message = parsed.error.message
      if (isPlain(parsed.error?.details)) {
        details = parsed.error.details
        code = typeof details.code === "string" ? details.code : undefined
      }
    } catch {
      // Not JSON: keep the text.
    }
    throw new ThreadWorkspaceReadError(
      response.status,
      code,
      `Worker answered ${response.status}${code ? ` (${code})` : ""}: ${message}`,
      details,
    )
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw malformed("not JSON")
  }
  return verify(body, threadId, options.root, init)
}
