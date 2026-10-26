<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180" />
</p>

# @b4run/postgres-storage

Supported Postgres persistence for B4.run checkpoints, Agent Protocol threads, and permission grants across application instances.

**Use this when:** You are replacing B4.run's local durable stores with shared Postgres persistence.

## Install

```bash
pnpm add @b4run/postgres-storage pg
```

## Example

```ts
import { Pool } from "pg"
import { createPostgresThreadsStore } from "@b4run/postgres-storage"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const threadsStore = createPostgresThreadsStore({ pool })

await threadsStore.ready()

// During application shutdown:
await threadsStore.close()
await pool.end()
```

Every store accepts `schema` (default `public`) and `tablePrefix` (default `b4`), so several
applications or deployment environments can share one database. Both must be lowercase SQL
identifiers matching `^[a-z_][a-z0-9_]*$`; the migration pass creates the schema if needed. Pass the
same values to the checkpointer, threads store and permissions store. Apps built with
`b4 build` for the `hono` or `vercel` target set these through the `B4_PG_SCHEMA` and
`B4_PG_TABLE_PREFIX` runtime bindings instead.

## Runtime and stability

- `@b4run/postgres-storage` is a supported edge-safe application surface that requires an injected structural pool. The tested edge path is local workerd with a Neon WebSocket pool; this is not a claim about every edge host.
- `@b4run/postgres-storage/node` is a supported node-only application surface that can create a `pg` pool from a connection string.

Migrations are memoized per store instance. An injected pool remains caller-owned unless `ownsPool: true`; a pool created by the Node entry is store-owned. Close stores and caller-owned pools during application shutdown.

## Request-scoped run admission

`createPostgresRunAdmission({ pool })` coordinates ownership of one thread across
replicas. Create one instance per request, initialize its `ready()` method, and
pass its `pool` to every runtime store used by that request. Initialization and
authorization queries may run before acquisition. Call `tryAcquire(threadId)`
before reading the checkpoint that determines a run or accepting callback
answers. A `false` result means another request owns the thread and may be retried.
An acquired instance rejects a different thread; release and ownership loss are
terminal. Await `release()` after graph work and final persistence finish, or use
`close()` to also close a pool owned by this instance. Caller-supplied pools stay
open unless `ownsPool` is set. The Node entry also accepts `connectionString`.

The default lease is 30 seconds, renewed every 10 seconds. `leaseDurationMs` and
`heartbeatIntervalMs` accept positive integer milliseconds; the heartbeat must be
shorter than the lease. Expiry and renewal use the database clock. Observe
`signal` to stop work after ownership loss or release. An expired owner cannot
renew or commit runtime storage writes, even after another request takes over.
This coordination does not provide exactly-once external tool effects.

Once acquired, `pool.query()` executes one statement in a short fenced
transaction. `pool.connect()` additionally supports explicit `BEGIN` (or
`START TRANSACTION`), `COMMIT` (or `END`), and `ROLLBACK`, with an optional trailing
semicolon. Nested transactions, savepoints, transaction-control modifiers, and
multiple statements in a fenced query are rejected. SQL literals and comments
may contain semicolons. Fenced SQL accepts positional parameters such as `$1`;
pass data through these parameters. Dollar signs other than positional parameter
markers and backslashes in the SQL text are rejected, including dollar-quoted
strings and dollar-bearing identifiers. Bound values may contain these characters.
This deliberately limited SQL subset serves the runtime stores; it is not an
arbitrary SQL execution interface. Complete these transactions around individual
storage operations; do not hold them through model generation. A synchronous client
`release()` finishes rollback before making the underlying connection available
for reuse. Released or lost admissions never resume unfenced access.


For a custom Node fetch embedding, return the admission with its fenced stores
from `requestStores`. Migrate **all** stores before the first claim, because active
fencing deliberately rejects multi-statement migration batches. The runtime then
claims after authorization and finalizes ownership after actual execution cleanup.
Generated Vercel/Hono output supplies this wiring automatically.

```ts
import {
  createPostgresClientToolCallStore,
  createPostgresPermissionsStore,
  createPostgresPool,
  createPostgresRunAdmission,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "@b4run/postgres-storage/node"

const requestStores = async () => {
  const pool = createPostgresPool({ connectionString: process.env.DATABASE_URL })
  try {
    const runAdmission = createPostgresRunAdmission({ pool })
    const naming = { pool: runAdmission.pool }
    const stores = {
      checkpointer: postgresCheckpointer(naming),
      clientToolStore: createPostgresClientToolCallStore(naming),
      permissionsStore: createPostgresPermissionsStore(naming),
      threadsStore: createPostgresThreadsStore(naming),
    }
    await Promise.all([runAdmission.ready(), ...Object.values(stores).map((store) => store.ready())])
    return {
      ...stores,
      runAdmission,
      dispose: async () => {
        try { await runAdmission.close() } finally { await pool.end() }
      },
    }
  } catch (error) {
    await pool.end()
    throw error
  }
}
```

This fences the injected checkpoint, thread, permission, and client-tool stores.
Separately configured memory and boot-owned approval-grant stores are not wrapped.
The existing managed-workspace restriction on `requestStores` remains in place.
The process-local run registry remains the default for embeddings without shared
admission; sharing Postgres data alone does not provide execution exclusion.

## Related

- [Postgres Storage API reference](https://b4.run/docs/api/postgres-storage) — exact options, stores, and lifecycle.
- [Persistence and Tenancy](https://b4.run/docs/persistence) — application configuration and deployment guidance.
- [`@b4run/sqlite-storage`](https://www.npmjs.com/package/@b4run/sqlite-storage) — local SQLite persistence.
- [`@b4run/permissions`](https://www.npmjs.com/package/@b4run/permissions) — permission-store contracts.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/postgres-storage` changelog](https://github.com/cacheplane/b4run/blob/main/packages/postgres-storage/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
