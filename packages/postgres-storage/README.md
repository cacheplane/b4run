<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180" />
</p>

# @b4run/postgres-storage

Supported Postgres persistence for B4.run checkpoints, Agent Protocol threads, permission grants, and application-owned documents across application instances.

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

## Application documents

The same package also stores state your *application* owns, as versioned JSON documents written
with compare-and-swap:

```ts
import { documentStoreFromEnv } from "@b4run/postgres-storage/node"

const sessions = await documentStoreFromEnv<Session>({ name: "sessions" })

const key = await sessions.create(initial)
const doc = await sessions.load(key)
await sessions.commit(key, doc.version, next) // throws ConflictError when stale
```

`documentStoreFromEnv` uses Postgres when `DATABASE_URL` is set and process memory when it is not,
so an application runs with no infrastructure and deploys with no code change. The contract and the
in-memory implementation live in [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk); see the
[Application Document Store guide](https://b4.run/docs/document-store).

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

## Related

- [Postgres Storage API reference](https://b4.run/docs/api/postgres-storage) — exact options, stores, and lifecycle.
- [Persistence and Tenancy](https://b4.run/docs/persistence) — application configuration and deployment guidance.
- [`@b4run/sqlite-storage`](https://www.npmjs.com/package/@b4run/sqlite-storage) — local SQLite persistence.
- [`@b4run/permissions`](https://www.npmjs.com/package/@b4run/permissions) — permission-store contracts.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/postgres-storage` changelog](https://github.com/cacheplane/b4run/blob/main/packages/postgres-storage/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
