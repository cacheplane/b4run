# @b4run/permissions

Permission matching and approval-store contracts for B4.run agents.

**Use this when:** You are building permission matching or approval-store integrations for a B4.run agent.

## Install

```bash
pnpm add @b4run/permissions
```

## Example

```ts
import { matchPermission } from "@b4run/permissions"

const decision = matchPermission(
  "bash",
  "pnpm test",
  { bash: ["pnpm"] },
  { bash: ["pnpm publish"] },
)
```

## Runtime and stability

- `@b4run/permissions` is an edge-safe, supported integration surface.
- `@b4run/permissions/node` is a node-only, supported integration surface.
- `@b4run/permissions/internal/rule-coordinator` is edge-safe and internal.

The root entry owns matching and portable contracts. Use the Node entry only for filesystem-backed approval-store integration.

## Remembered-rule intents

`PermissionsStore.rememberedRules` optionally prepares and conditionally applies
idempotent rule batches in the configured permission scope. The Node store keeps
private scope/revision/receipt metadata beside the existing version-1 allow/deny
maps, uses atomic flushed replacement and a separate kernel lock, and reads the
current file for every writer. Applied intent retries never re-add later removed
rules. Full restoration of old private metadata is a restore boundary. Custom
stores without this port cannot accept coordinated Always; Once/Deny still work.
`@b4run/permissions/internal/rule-coordinator` is internal portable backend plumbing.

## Related

- [Permissions API reference](https://b4.run/docs/api/permissions) — exact matching and store contracts.
- [Permissions guide](https://b4.run/docs/permissions) — application policy and approval workflows.
- [`@b4run/postgres-storage`](https://www.npmjs.com/package/@b4run/postgres-storage) — shared Postgres-backed permission decisions.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/permissions` changelog](https://github.com/cacheplane/b4run/blob/main/packages/permissions/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
