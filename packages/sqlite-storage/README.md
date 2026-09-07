# @b4run/sqlite-storage

SQLite persistence for B4.run checkpoints and Agent Protocol threads.

**Use this when:** You need to use B4.run's local checkpoint or thread persistence directly.

## Install

```bash
pnpm add @b4run/sqlite-storage
```

## Example

```ts
import { createThreadsStore, sqliteCheckpointer } from "@b4run/sqlite-storage"

export const checkpointer = sqliteCheckpointer({ path: ".b4/checkpoints.sqlite" })
export const threadsStore = createThreadsStore({ path: ".b4/threads.sqlite" })
```

## Runtime and stability

`@b4run/sqlite-storage` is a node-only, supported application surface.

SQLite is a local process-oriented default. Use shared persistence when multiple application instances must observe the same checkpoints or threads.

## Related

- [SQLite Storage API reference](https://b4.run/docs/api/sqlite-storage) — exact checkpoint and thread-store contracts.
- [Persistence and Tenancy](https://b4.run/docs/persistence) — application configuration and storage boundaries.
- [`@b4run/postgres-storage`](https://www.npmjs.com/package/@b4run/postgres-storage) — shared Postgres persistence.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/sqlite-storage` changelog](https://github.com/cacheplane/b4-run/blob/main/packages/sqlite-storage/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4-run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4-run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4-run/blob/main/LICENSE).
