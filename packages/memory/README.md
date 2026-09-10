<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180" />
</p>

# @b4run/memory

Supported long-term memory storage, ranking, browsing, namespace, and reconciliation primitives. Most route authors should declare memory with `defineMemory()` and use this package when they need direct store access.

**Use this when:** You need to access memory stores or ranking primitives directly instead of using only `defineMemory()`.

## Install

```bash
pnpm add @b4run/memory
```

## Example

```ts
import { sqliteMemoryStore } from "@b4run/memory"

const store = sqliteMemoryStore({ path: ".b4/memory.sqlite" })
```

Supported focused entry points are `@b4run/memory/browse`, `@b4run/memory/namespace`, and `@b4run/memory/reconcile`.

## Runtime and stability

- `@b4run/memory` is a supported node-only application surface because it includes SQLite.
- `@b4run/memory/browse` is a supported, dependency-free edge-safe integration surface.
- `@b4run/memory/namespace` is a supported edge-safe integration surface.
- `@b4run/memory/reconcile` is a supported edge-safe integration surface.

SQLite rows contain plaintext content, data, sources, and tags. Treat the database as sensitive application data and enforce tenant scope at the caller boundary.

## Related

- [Memory API reference](https://b4.run/docs/api/memory) — exact store, query, and subpath contracts.
- [Long-term Memory](https://b4.run/docs/memory/long-term) — application configuration.
- [Recall and Retrieval](https://b4.run/docs/memory/retrieval) and [Browse and Manage Memory](https://b4.run/docs/memory/browse) — retrieval and administration workflows.
- [`@b4run/memory-pgvector`](https://www.npmjs.com/package/@b4run/memory-pgvector) — shared Postgres-backed vector memory.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/memory` changelog](https://github.com/cacheplane/b4run/blob/main/packages/memory/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
