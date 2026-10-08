import type { MemoryStore } from "@b4run/memory"
// The reconcile helper comes from the pure "./reconcile" subpath, never the
// barrel: the barrel re-exports sqliteMemoryStore and so reaches node:sqlite.
import { parseNamespace } from "@b4run/memory/namespace"
import { approveWithReconcile } from "@b4run/memory/reconcile"
import type { B4Principal } from "@b4run/sdk"
import { formatErrorMessage } from "../output.js"
import { createExecutionErrorBody, createRequestErrorBody } from "./server-errors.js"

/** The identity keys used when the route's `memory.ts` cannot be consulted. */
const DEFAULT_IDENTITY_KEYS = ["subject", "predicate"] as const

/**
 * Which namespaces one request may review. Absent means every namespace: an app
 * with no `src/auth.ts`, or a caller its `canReviewMemory` admits.
 */
export interface MemoryAccess {
  readonly visible: (namespace: string) => boolean
}

/** The dimensions a principal can own; `workspace` and `route` are the app's. */
const OWNED_DIMENSIONS = ["tenant", "user", "agent"] as const

/**
 * Whether `namespace` is one of the caller's: every owned dimension it carries
 * equals what `resolveScope` gives this caller for that namespace's route. A
 * namespace with none (the shared `workspace+route` one) is every caller's. A
 * `resolveScope` that is absent, throws, or omits the dimension owns nothing,
 * so an anonymous caller never reaches a `user`-scoped candidate.
 */
export function callerOwnsNamespace(
  namespace: string,
  context: {
    readonly appRoot: string
    readonly principal: B4Principal | undefined
    readonly resolveScope:
      | ((ctx: {
          readonly routePath: string
          readonly appRoot: string
          readonly principal: B4Principal | undefined
        }) => Record<string, string>)
      | undefined
  },
): boolean {
  const parsed = parseNamespace(namespace)
  const owned = OWNED_DIMENSIONS.filter((dimension) => parsed[dimension] !== undefined)
  if (owned.length === 0) return true
  let scope: Record<string, string> | undefined
  try {
    scope = context.resolveScope?.({
      appRoot: context.appRoot,
      principal: context.principal,
      routePath: parsed.route ?? "",
    })
  } catch {
    return false
  }
  return owned.every((dimension) => scope?.[dimension] === parsed[dimension])
}

/** The 404 for a record that is missing or outside the caller's namespaces: one answer for both. */
function notFound(id: string): Response {
  return Response.json(createRequestErrorBody(`Record not found: ${id}`), { status: 404 })
}

/**
 * GET /memory/candidates — list candidate records for a web UI to review:
 * every namespace (empty prefix), narrowed to the caller's own when `access`
 * is given.
 */
export async function handleMemoryListRequest(options: {
  readonly memoryStore: MemoryStore
  readonly access?: MemoryAccess
}): Promise<Response> {
  const { access, memoryStore } = options
  const all = await memoryStore.listCandidates("")
  const candidates = access ? all.filter((record) => access.visible(record.namespace)) : all
  return Response.json({ candidates }, { status: 200 })
}

/**
 * POST /memory/candidates/:id/approve — approve a candidate with the same
 * supersede-aware reconciliation as `runApprove` in `commands/memory.ts`:
 * 404 if the record is missing, 409 if it isn't currently a candidate, else
 * `approveWithReconcile` classifies it against active records with the same
 * identity key — a contradicting active row is superseded, an identical one
 * dedupes the candidate. The response keeps the original `{ record }` shape
 * and adds `action` ("activated" | "superseded" | "deduped") and the
 * `superseded` records.
 */
export async function handleMemoryApproveRequest(options: {
  readonly appRoot: string
  readonly memoryStore: MemoryStore
  readonly id: string
  /**
   * Injected because resolving a route's declared `identity` reads its
   * `memory.ts` from disk. Absent (edge runtimes, which have none), the
   * default semantic identity is used — the same keys `resolveIdentityKeys`
   * itself falls back to when the route cannot be resolved.
   */
  readonly resolveIdentityKeys?: (
    appRoot: string,
    namespace: string,
  ) => Promise<{ readonly keys: readonly string[]; readonly fallback: boolean }>
  /** Narrow to the caller's namespaces; a record outside them is a 404, like a missing one. */
  readonly access?: MemoryAccess
}): Promise<Response> {
  const { appRoot, memoryStore, id } = options
  const record = await memoryStore.get(id)
  if (!record || (options.access && !options.access.visible(record.namespace))) {
    return notFound(id)
  }
  if (record.status !== "candidate") {
    return Response.json(
      createRequestErrorBody(`Record "${id}" is not a candidate (status: ${record.status})`),
      { status: 409 },
    )
  }
  try {
    const identityKeys = options.resolveIdentityKeys
      ? (await options.resolveIdentityKeys(appRoot, record.namespace)).keys
      : DEFAULT_IDENTITY_KEYS
    const result = await approveWithReconcile(memoryStore, id, {
      identityKeys,
      now: new Date().toISOString(),
    })
    return Response.json(
      { record: result.approved, action: result.action, superseded: result.superseded },
      { status: 200 },
    )
  } catch (cause) {
    // Identity resolution (a broken route memory.ts) or reconciliation racing
    // a concurrent write — surface as JSON rather than a generic 500 page.
    return Response.json(createExecutionErrorBody(`Approve failed: ${formatErrorMessage(cause)}`), {
      status: 500,
    })
  }
}

/**
 * POST /memory/candidates/:id/reject — delete the record outright (mirrors
 * `runReject` in `commands/memory.ts`).
 */
export async function handleMemoryRejectRequest(options: {
  readonly memoryStore: MemoryStore
  readonly id: string
  /**
   * Narrow to the caller's namespaces. With it, a record that is missing or
   * outside them is a 404 (one answer for both); without it, a missing record
   * is deleted as a no-op, as before.
   */
  readonly access?: MemoryAccess
}): Promise<Response> {
  const { access, memoryStore, id } = options
  if (access) {
    const record = await memoryStore.get(id)
    if (!record || !access.visible(record.namespace)) return notFound(id)
  }
  await memoryStore.delete(id)
  return Response.json({ ok: true }, { status: 200 })
}
