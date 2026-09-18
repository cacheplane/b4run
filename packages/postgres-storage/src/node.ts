/**
 * Node-only entry: the `connectionString` convenience.
 *
 * Kept out of the main entry because a *value* import of `pg` pulls net/tls/dns
 * into the module graph, which makes the package unlinkable on an edge runtime
 * (verified: 16 unresolved-builtin errors bundling this file on platform:
 * browser — `test/edge-bundle.test.ts` keeps that a negative control).
 *
 * Every export here is the main entry's factory with the pool filled in, so
 * behaviour is otherwise identical — including pool ownership: a store that
 * builds its own pool from `connectionString` ends it on `close()`, and a pool
 * passed in stays the caller's.
 */
import { createMemoryDocumentStore, type DocumentStore } from "@b4run/sdk"
import { Pool, type PoolConfig } from "pg"
import { type B4PostgresSaver, postgresCheckpointer as baseCheckpointer } from "./checkpointer.js"
import {
  createPostgresDocumentStore as baseCreateDocumentStore,
  type PostgresDocumentStore,
  type PostgresDocumentStoreOptions,
} from "./documents.js"
import { namingFromEnv } from "./naming.js"
import type { PostgresStoreOptions } from "./options.js"
import {
  createPostgresPermissionsStore as baseCreatePermissionsStore,
  type PostgresPermissionsStore,
  type PostgresPermissionsStoreOptions,
} from "./permissions.js"
import type { SqlPool } from "./sql.js"
import {
  createPostgresThreadsStore as baseCreateThreadsStore,
  type PostgresThreadsStore,
} from "./threads.js"

/** Main-entry options plus the connection string this entry can act on. */
export interface NodePostgresStoreOptions extends PostgresStoreOptions {
  /** Postgres connection string; used to build an owned pool when `pool` is absent. */
  readonly connectionString?: string
}

/** Permissions-store options plus the connection string this entry can act on. */
export interface NodePostgresPermissionsStoreOptions extends PostgresPermissionsStoreOptions {
  /** Postgres connection string; used to build an owned pool when `pool` is absent. */
  readonly connectionString?: string
}

/**
 * Supply the pool the main entry now requires, and say who owns it.
 *
 * `ownsPool` carries the lifecycle decision explicitly rather than being
 * inferred from "was a pool passed in": from the base store's point of view a
 * pool is always passed in now, so without this flag `close()` would silently
 * stop ending the pool a connection string built.
 *
 * A pool built HERE also gets an `'error'` listener. `pg` emits that event on
 * the POOL when an IDLE client fails, and an EventEmitter `'error'` with no
 * listener is an uncaught exception — the process dies. Idle connections are
 * dropped as a matter of course (server restart, failover,
 * `idle_session_timeout`, a container stopping), so without a listener a
 * routine Postgres blip takes the whole app down instead of the pool quietly
 * replacing one connection. That matters most precisely here, where the stores
 * hold durable state for long-running deployments.
 *
 * Nothing to recover: pg has already discarded the broken client and the next
 * query opens a new one. Warn rather than swallow, so an unhealthy database
 * stays visible.
 *
 * A caller-supplied pool is left alone — its owner controls its lifecycle and
 * its error handling, and pg requires every pool to have a listener, so
 * attaching one to someone else's pool would mask that contract. This is the
 * only place in the package that constructs a pool, so that rule cannot drift
 * between the checkpointer, threads and permissions stores.
 */
function poolFor(options: NodePostgresStoreOptions): {
  readonly pool: SqlPool
  readonly ownsPool: boolean
} {
  if (options.pool) return { pool: options.pool, ownsPool: options.ownsPool ?? false }
  const pool = createPostgresPool(
    options.connectionString ? { connectionString: options.connectionString } : {},
  )
  return { pool, ownsPool: true }
}

/**
 * Build the `pg` pool this package builds for itself, with its `'error'`
 * listener already attached (see `poolFor` for why that listener is not
 * optional).
 *
 * Public so a generated deployment entry — the CLI's Vercel `stores.mjs` —
 * can open a TCP pool for a non-Neon `DATABASE_URL` through THIS package's
 * declared `pg` dependency, rather than importing `pg` by a bare specifier the
 * app itself never declared (which resolves under a hoisting layout and fails
 * under pnpm's strict one). The caller owns the returned pool and ends it.
 */
export function createPostgresPool(config: PoolConfig = {}): Pool {
  const pool = new Pool(config)
  pool.on("error", (error) => {
    console.warn(`[b4:storage] postgres pool client error (connection dropped): ${String(error)}`)
  })
  return pool
}

/** Build a Postgres-backed LangGraph checkpointer, optionally from a connection string. */
export function postgresCheckpointer(options: NodePostgresStoreOptions = {}): B4PostgresSaver {
  return baseCheckpointer({ ...options, ...poolFor(options) })
}

/** Build a Postgres-backed threads store, optionally from a connection string. */
export function createPostgresThreadsStore(
  options: NodePostgresStoreOptions = {},
): PostgresThreadsStore {
  return baseCreateThreadsStore({ ...options, ...poolFor(options) })
}

/** Build a Postgres-backed permissions store, optionally from a connection string. */
export function createPostgresPermissionsStore(
  options: NodePostgresPermissionsStoreOptions = {},
): PostgresPermissionsStore {
  return baseCreatePermissionsStore({ ...options, ...poolFor(options) })
}

/** Document-store options plus the connection string this entry can act on. */
export interface NodePostgresDocumentStoreOptions extends PostgresDocumentStoreOptions {
  /** Postgres connection string; used to build an owned pool when `pool` is absent. */
  readonly connectionString?: string
}

/** Build a Postgres-backed application document store, optionally from a connection string. */
export function createPostgresDocumentStore<T>(
  options: NodePostgresDocumentStoreOptions,
): PostgresDocumentStore<T> {
  return baseCreateDocumentStore<T>({ ...options, ...poolFor(options) })
}

/**
 * The pool `documentStoreFromEnv` shares, and the naming it resolved.
 *
 * Module scope, so N named stores in one process open ONE pool and migrate
 * once, rather than one pool per collection — which is how an app with a
 * handful of stores quietly exhausts a managed Postgres connection cap. The
 * `/node` entry is Node-only by construction, so a module-scope pool is safe
 * here in a way it is not on workerd (see `createRequestStores` in the
 * generated edge runtime, which is per-request for exactly that reason).
 */
let backend:
  | Promise<{ readonly pool: Pool; readonly schema: string; readonly tablePrefix: string }>
  | undefined

/** Named stores handed out so far, so two calls for one name share an instance. */
const stores = new Map<string, Promise<DocumentStore<unknown>>>()

/**
 * A document store chosen from the environment: Postgres when `DATABASE_URL`
 * is set, process memory when it is not.
 *
 * This is the decision B4.run already makes for its own stores, applied to an
 * application's. It is what lets an example clone-and-run with no
 * infrastructure and deploy with no code change, and what lets its tests run
 * without a database while the SAME contract is verified against Postgres in
 * CI.
 *
 * Memoized per process and per `name`, and the memo is DROPPED when a cold
 * start fails — otherwise the first boot's connection error is cached and
 * every later call replays it forever, long after the database came back.
 *
 * `B4_PG_SCHEMA` / `B4_PG_TABLE_PREFIX` apply, exactly as they do to B4.run's
 * own tables; see {@link namingFromEnv}.
 */
export function documentStoreFromEnv<T>(options: {
  readonly name: string
}): Promise<DocumentStore<T>> {
  const { name } = options
  const existing = stores.get(name)
  if (existing) return existing as Promise<DocumentStore<T>>

  const opened = (async (): Promise<DocumentStore<unknown>> => {
    const connectionString = process.env["DATABASE_URL"]
    if (!connectionString) return createMemoryDocumentStore()
    backend ??= (async () => {
      // Resolved before the pool is opened, so a malformed binding fails by
      // name with nothing to close.
      const { schema, tablePrefix } = namingFromEnv(process.env)
      const pool = new Pool({ connectionString })
      pool.on("error", (error) => {
        console.warn(
          `[b4:storage] postgres pool client error (connection dropped): ${String(error)}`,
        )
      })
      return { pool, schema, tablePrefix }
    })()
    // Captured so the rollback below can tell "the backend I used" from "a
    // backend some later call has since opened", and never discard the latter.
    const opening = backend
    try {
      const { pool, schema, tablePrefix } = await opening
      const store = baseCreateDocumentStore<unknown>({ name, pool, schema, tablePrefix })
      // Migrate eagerly, so a misconfigured database fails at startup rather
      // than inside whichever request happens to touch the store first.
      await store.ready()
      return store
    } catch (error) {
      // The POOL has to go too, not just this name's memo. `new Pool` connects
      // nothing, so the failure surfaces here, on the first query — leaving the
      // pool memoized would pin every later call to a connection string that is
      // already known not to work, which is precisely the state a retry exists
      // to escape.
      if (backend === opening) {
        backend = undefined
        void opening.then(({ pool }) => pool.end()).catch(() => {})
      }
      throw error
    }
  })().catch((error: unknown) => {
    stores.delete(name)
    throw error
  })

  stores.set(name, opened)
  return opened as Promise<DocumentStore<T>>
}

/**
 * End the shared pool and forget every memoized store.
 *
 * For process shutdown and for tests, which otherwise leave a module-scope
 * pool holding the event loop open. A later `documentStoreFromEnv` starts
 * clean, so this is safe to call more than once.
 */
export async function closeDocumentStoresFromEnv(): Promise<void> {
  const opened = backend
  backend = undefined
  stores.clear()
  if (opened) await (await opened).pool.end()
}

export * from "./index.js"
