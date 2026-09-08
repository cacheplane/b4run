<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180" />
</p>

# @b4run/memory-pgvector

Supported Postgres and pgvector storage for shared long-term memory across B4.run application instances.

**Use this when:** You need to share vector memory across multiple B4.run application instances.

## Install

```bash
pnpm add @b4run/memory-pgvector pg
```

The adapter requires the `pg` client at runtime; the install command includes it explicitly.

## Example

```ts
import { pgvectorMemoryStore } from "@b4run/memory-pgvector"

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is required")

const store = pgvectorMemoryStore({
  connectionString,
  dimensions: 1536,
})

// During application shutdown:
await store.close()
```

## Runtime and stability

`@b4run/memory-pgvector` is a supported node-only application surface. It initializes the pgvector extension and tables lazily, so the database role needs the corresponding DDL and extension privileges. Calling `close()` ends a store-created pool. For an injected caller-owned pool, `close()` is a no-op; the caller must end the pool separately. Stored memory is plaintext application data. Updating a record preserves its existing embedding; re-embed changed semantic content before relying on vector retrieval.

## Related

- [pgvector Memory API reference](https://b4.run/docs/api/memory-pgvector) — exact options and lifecycle.
- [Long-term Memory](https://b4.run/docs/memory/long-term) — application configuration.
- [Recall and Retrieval](https://b4.run/docs/memory/retrieval) — hybrid search behavior.
- [`@b4run/memory`](https://www.npmjs.com/package/@b4run/memory) — shared memory contracts and ranking primitives.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/memory-pgvector` changelog](https://github.com/cacheplane/b4run/blob/main/packages/memory-pgvector/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
