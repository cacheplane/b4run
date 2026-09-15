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

Workspace source-bundle persistence and installation ownership are internal
components. The installation owner keeps a durable identity and source bundles in
`.b4/workspaces/state.sqlite`, with a separate SQLite writer lock that admits one
active owner on a local host. Separate state transactions remain available while
that lock is held; it does not serialize every thread into one run.

An interrupted first initialization can resume. An established installation with
missing or inconsistent state fails closed. Process death releases the ownership
lock. This does not support network filesystems, multiple hosts, or recovery from
loss or replacement of the entire state directory.

These components are not wired into runtime startup yet. No managed workspace
lifecycle store is exported by this package yet.

## Related

- [SQLite Storage API reference](https://b4.run/docs/api/sqlite-storage) — exact checkpoint and thread-store contracts.
- [Persistence and Tenancy](https://b4.run/docs/persistence) — application configuration and storage boundaries.
- [`@b4run/postgres-storage`](https://www.npmjs.com/package/@b4run/postgres-storage) — shared Postgres persistence.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/sqlite-storage` changelog](https://github.com/cacheplane/b4run/blob/main/packages/sqlite-storage/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
