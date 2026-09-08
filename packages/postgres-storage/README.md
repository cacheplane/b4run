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
