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

Workspace source-bundle persistence and installation ownership support managed
workspaces. The installation owner keeps a durable identity and source bundles in
`.b4/workspaces/state.sqlite`, with a separate SQLite writer lock that admits one
active owner on a local host. Separate state transactions remain available while
that lock is held; it does not serialize every thread into one run.

An interrupted first initialization can resume. An established installation with
missing or inconsistent state fails closed. Process death releases the ownership
lock. This does not support network filesystems, multiple hosts, or recovery from
loss or replacement of the entire state directory.

The Node runtime acquires ownership before admitting managed workspace work.
`openWorkspaceInstallation` exposes guarded source and association stores;
creation and deletion transitions remain durable across process restarts.

## Agent Protocol runtime installation

`openRuntimeInstallation(appRoot)` opens the fresh local runtime namespace at
`.b4/agent-protocol/v1/runtime.sqlite` with WAL, foreign keys, and FULL synchronous
commits. It holds a separate kernel SQLite lock until `close()`, records process
start/boot identity and a nonce, and refuses declared replicas or cluster workers.
An incompatible schema or installation marker is inspected without modifying the
runtime database or its sidecars. Legacy runtime files and independent memory,
Store, rules, and workspace data are preserved.

This Node host installation API does not bind request authority or activate the
existing CLI boot paths. The authority bridge and coordinated runtime cutover
remain required integration work. Internal transaction tests cover atomic grant
consumption, asynchronous rollback, committed reads, and durable fences; they do
not certify the full host profile. Copy/state operations await the state service;
rollback/deletion await maintenance; recovery materialization awaits projection.
Those controls fail before mutation until their owners implement them. Linux,
macOS, and Windows have process identity implementations; native platform
qualification remains separate from the local test evidence.

## Related

- [SQLite Storage API reference](https://b4.run/docs/api/sqlite-storage) — exact checkpoint and thread-store contracts.
- [Persistence and Tenancy](https://b4.run/docs/persistence) — application configuration and storage boundaries.
- [`@b4run/postgres-storage`](https://www.npmjs.com/package/@b4run/postgres-storage) — shared Postgres persistence.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/sqlite-storage` changelog](https://github.com/cacheplane/b4run/blob/main/packages/sqlite-storage/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
